import { describe, expect, it } from 'vitest';
import { createActivation, type ActivationDeps, type TabState } from './activation.ts';

const EPISODE = 'https://manga.example/episode/123';

/** 用記憶體模擬 Chrome：tab 的網址、注入紀錄、side panel 紀錄。 */
function fakeChrome(urls: Record<number, string>) {
  const states = new Map<number, TabState>();
  const calls = { openedPanels: [] as number[], injected: [] as number[], stopped: [] as number[] };
  const statusEvents: [number, boolean][] = [];
  const failInjectionFor = new Set<number>();
  const createdSeries: string[] = [];
  /** 網址模式：網址 → Series ID。 */
  const patterns = new Map<string, string>();
  const seriesChanges: [number, string][] = [];
  const deps: ActivationDeps = {
    store: {
      get: async (tabId) => states.get(tabId),
      set: async (tabId, s) => void states.set(tabId, s),
      delete: async (tabId) => void states.delete(tabId),
    },
    getTabUrl: async (tabId) => urls[tabId],
    openSidePanel: async (tabId) => void calls.openedPanels.push(tabId),
    injectContentScript: async (tabId) => {
      if (failInjectionFor.has(tabId)) throw new Error('Cannot access contents of the page');
      calls.injected.push(tabId);
    },
    stopContentScript: async (tabId) => void calls.stopped.push(tabId),
    onStatusChanged: (tabId, active) => void statusEvents.push([tabId, active]),
    seriesForUrl: async (url) => {
      const remembered = patterns.get(url);
      if (remembered) return remembered;
      const id = `provisional-${createdSeries.length + 1}`;
      createdSeries.push(url);
      return id;
    },
    rememberedSeries: async (url) => patterns.get(url),
    onSeriesChanged: (tabId, seriesId) => void seriesChanges.push([tabId, seriesId]),
  };
  return { deps, calls, statusEvents, failInjectionFor, urls, createdSeries, patterns, seriesChanges };
}

describe('activate', () => {
  it('啟動後 tab 為已啟動、打開 side panel、注入 content script', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.isActive(1)).toBe(true);
    expect(chrome.calls.openedPanels).toEqual([1]);
    expect(chrome.calls.injected).toEqual([1]);
  });

  it('在任何 await 之前就同步打開 side panel（否則會失去 user gesture）', () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    void activation.activate(1);

    expect(chrome.calls.openedPanels).toEqual([1]);
  });

  it('side panel 打不開（沒有 user gesture，例如測試入口）仍然會啟動', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.deps.openSidePanel = () =>
      Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture.'));
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.isActive(1)).toBe(true);
  });

  it('注入失敗（例如 chrome:// 頁面）時不算啟動', async () => {
    const chrome = fakeChrome({ 1: 'chrome://settings/' });
    chrome.failInjectionFor.add(1);
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.isActive(1)).toBe(false);
  });

  it('啟動成功會通知狀態改變', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(chrome.statusEvents).toEqual([[1, true]]);
  });
});

describe('stop', () => {
  it('停止後通知 content script 清理，之後重新整理不再注入', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.stop(1);
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.isActive(1)).toBe(false);
    expect(chrome.calls.stopped).toEqual([1]);
    expect(chrome.calls.injected).toEqual([1]);
    expect(chrome.statusEvents.at(-1)).toEqual([1, false]);
  });
});

describe('tab 生命週期', () => {
  it('同 origin 重新整理載入完成後自動重新注入', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: EPISODE });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.calls.injected).toEqual([1, 1]);
    expect(await activation.isActive(1)).toBe(true);
  });

  it('同 origin 換到另一頁仍維持啟動並重新注入', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.urls[1] = 'https://manga.example/episode/456';
    await activation.handleTabUpdated(1, { status: 'loading', url: chrome.urls[1] });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.calls.injected).toEqual([1, 1]);
  });

  it('換 origin 就停止，之後載入完成也不注入', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.urls[1] = 'https://example.com/';
    await activation.handleTabUpdated(1, { status: 'loading', url: chrome.urls[1] });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.isActive(1)).toBe(false);
    expect(chrome.calls.injected).toEqual([1]);
    expect(chrome.statusEvents).toEqual([
      [1, true],
      [1, false],
    ]);
  });

  it('換 origin 的事件還沒處理完，載入完成的事件就到了，也不注入', async () => {
    // Chrome 不等上一個 listener 的 promise，兩個 onUpdated 事件會同時在處理
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.urls[1] = 'https://example.com/';
    const urlChanged = activation.handleTabUpdated(1, { status: 'loading', url: chrome.urls[1] });
    const loaded = activation.handleTabUpdated(1, { status: 'complete' });
    await Promise.all([urlChanged, loaded]);

    expect(await activation.isActive(1)).toBe(false);
    expect(chrome.calls.injected).toEqual([1]);
  });

  it('沒啟動的 tab 載入完成不注入', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.calls.injected).toEqual([]);
  });

  it('重新注入失敗（例如 activeTab 授權已失效）就停止', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.failInjectionFor.add(1);
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.isActive(1)).toBe(false);
  });

  it('關掉 tab 就清掉狀態', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabRemoved(1);

    expect(await activation.isActive(1)).toBe(false);
  });
});

describe('Series', () => {
  it('啟動時沒有預選到 Series，就用這個網址建一個 Provisional Series 給這個 tab', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(chrome.createdSeries).toEqual([EPISODE]);
    expect(await activation.getSeriesId(1)).toBe('provisional-1');
  });

  it('每次這樣的啟動各一個：停止後再啟動是新的 Provisional Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE, 2: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);
    await activation.activate(2);
    await activation.stop(1);
    await activation.activate(1);

    expect(await activation.getSeriesId(1)).toBe('provisional-3');
    expect(await activation.getSeriesId(2)).toBe('provisional-2');
  });

  it('已啟動的 tab 重新整理、再點一次圖示，沿用同一個 Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.activate(1);
    await activation.handleTabUpdated(1, { status: 'complete' });
    await activation.activate(1);

    expect(chrome.createdSeries).toHaveLength(1);
    expect(await activation.getSeriesId(1)).toBe('provisional-1');
  });

  it('網址模式預選到 Series 時用它，不建 Provisional Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.patterns.set(EPISODE, 'series-a');
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(chrome.createdSeries).toEqual([]);
    expect(await activation.getSeriesId(1)).toBe('series-a');
  });

  it('切換 Series 後這個 tab 改用新的 Series ID', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.setSeriesId(1, 'series-b');

    expect(await activation.getSeriesId(1)).toBe('series-b');
    expect(await activation.isActive(1)).toBe(true);
  });

  it('沒啟動的 tab 不能切換 Series', async () => {
    const activation = createActivation(fakeChrome({ 1: EPISODE }).deps);

    await activation.setSeriesId(1, 'series-b');

    expect(await activation.isActive(1)).toBe(false);
  });

  it('沒啟動的 tab 沒有 Series', async () => {
    const activation = createActivation(fakeChrome({ 1: EPISODE }).deps);

    expect(await activation.getSeriesId(1)).toBeUndefined();
  });
});

describe('同分頁換作品（#145）', () => {
  const OTHER_WORK = 'https://manga.example/title/999/episode/1';
  const NEXT_EPISODE = 'https://manga.example/episode/124';

  it('導航到記住了另一部 Series 的網址：換成那部 Series，並通知', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.patterns.set(EPISODE, 'series-a');
    chrome.patterns.set(OTHER_WORK, 'series-b');
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: OTHER_WORK });

    expect(await activation.getSeriesId(1)).toBe('series-b');
    expect(chrome.seriesChanges).toEqual([[1, 'series-b']]);
  });

  it('導航到沒記住的網址（例如同作品的下一話）：沿用目前的 Series，不建 Provisional Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.patterns.set(EPISODE, 'series-a');
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: NEXT_EPISODE });

    expect(await activation.getSeriesId(1)).toBe('series-a');
    expect(chrome.createdSeries).toEqual([]);
    expect(chrome.seriesChanges).toEqual([]);
  });

  it('導航到記住了同一部 Series 的網址：不算換作品，不通知', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.patterns.set(EPISODE, 'series-a');
    chrome.patterns.set(NEXT_EPISODE, 'series-a');
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: NEXT_EPISODE });

    expect(await activation.getSeriesId(1)).toBe('series-a');
    expect(chrome.seriesChanges).toEqual([]);
  });

  it('沒啟動的 tab 導航不查網址模式', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.patterns.set(OTHER_WORK, 'series-b');
    const activation = createActivation(chrome.deps);

    await activation.handleTabUpdated(1, { status: 'loading', url: OTHER_WORK });

    expect(await activation.getSeriesId(1)).toBeUndefined();
    expect(chrome.seriesChanges).toEqual([]);
  });

  it('換 origin 就停止，不換 Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.patterns.set('https://example.com/', 'series-b');
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: 'https://example.com/' });

    expect(chrome.seriesChanges).toEqual([]);
  });
});
