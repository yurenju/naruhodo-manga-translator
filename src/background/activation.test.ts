import { describe, expect, it } from 'vitest';
import type { TitleGuess } from '../shared/series.ts';
import type { TitleSignals } from '../shared/translator.ts';
import { createActivation, type ActivationDeps, type BlockedStep, type TabState } from './activation.ts';

const EPISODE = 'https://manga.example/episode/123';

/** 用記憶體模擬 Chrome：tab 的網址、注入紀錄、side panel 紀錄。 */
function fakeChrome(urls: Record<number, string>) {
  const states = new Map<number, TabState>();
  const calls = {
    openedPanels: [] as number[],
    /** 設定還沒讀到時：只呼叫 open，讓 Chrome 依同步過去的 enabled 決定開不開。 */
    openedIfEnabled: [] as number[],
    closedPanels: [] as number[],
    injected: [] as number[],
    stopped: [] as number[],
    onboardings: [] as [number, BlockedStep][],
  };
  /** Side Panel on Activation；undefined＝SW 剛醒來還沒讀到。 */
  const settings: { panelOnActivation: boolean | undefined; blocked: BlockedStep | undefined } = { panelOnActivation: true, blocked: undefined };
  const statusEvents: [number, boolean][] = [];
  const failInjectionFor = new Set<number>();
  const createdSeries: string[] = [];
  /** 網址模式：網址 → Series ID。 */
  const patterns = new Map<string, string>();
  const seriesChanges: [number, string][] = [];
  /** 每個 tab 頁面上的標題（document.title）；沒有就讀不到訊號。 */
  const titles: Record<number, string> = {};
  /** 每次送去猜的標題。 */
  const guesses: string[] = [];
  /** 設了就卡住猜測，直到呼叫 release()（模擬 Haiku 還沒回來）。 */
  let gate: Promise<void> | undefined;
  let release = () => {};
  const assigned: number[] = [];
  const deps: ActivationDeps = {
    store: {
      get: async (tabId) => states.get(tabId),
      set: async (tabId, s) => void states.set(tabId, s),
      delete: async (tabId) => void states.delete(tabId),
    },
    getTabUrl: async (tabId) => urls[tabId],
    sidePanelOnActivation: () => settings.panelOnActivation,
    openSidePanel: async (tabId, { onlyIfEnabled } = {}) => void (onlyIfEnabled ? calls.openedIfEnabled : calls.openedPanels).push(tabId),
    closeSidePanel: async (tabId) => void calls.closedPanels.push(tabId),
    blockedStep: async () => settings.blocked,
    openBlockedPage: async (tabId, step) => void calls.onboardings.push([tabId, step]),
    injectContentScript: async (tabId) => {
      if (failInjectionFor.has(tabId)) throw new Error('Cannot access contents of the page');
      calls.injected.push(tabId);
    },
    stopContentScript: async (tabId) => void calls.stopped.push(tabId),
    onStatusChanged: (tabId, active) => void statusEvents.push([tabId, active]),
    seriesForUrl: async (url, guess) => {
      const remembered = patterns.get(url);
      if (remembered) return { seriesId: remembered, by: 'urlPattern' };
      const guessed = await guess();
      if (guessed) return { seriesId: `title:${guessed.原名}`, by: 'created', originalTitle: guessed.原名 };
      const id = `provisional-${createdSeries.length + 1}`;
      createdSeries.push(url);
      return { seriesId: id, by: 'unnamed' };
    },
    seriesForGuess: async (guess) => ({ seriesId: `title:${guess.原名}`, by: 'title', originalTitle: guess.原名 }),
    readTitleSignals: async (tabId): Promise<TitleSignals | undefined> =>
      titles[tabId] === undefined ? undefined : { title: titles[tabId]!, ogTitle: '', headings: [] },
    async guessSeries(signals): Promise<TitleGuess | undefined> {
      guesses.push(signals.title);
      await gate;
      return signals.title ? { 原名: signals.title, 中文譯名: '' } : undefined;
    },
    rememberedSeries: async (url) => patterns.get(url),
    onSeriesChanged: (tabId, seriesId) => void seriesChanges.push([tabId, seriesId]),
    onSeriesAssigned: (tabId) => void assigned.push(tabId),
  };
  return {
    deps,
    calls,
    settings,
    statusEvents,
    failInjectionFor,
    urls,
    createdSeries,
    patterns,
    seriesChanges,
    titles,
    guesses,
    assigned,
    /** 之後的猜測卡住，直到呼叫回傳的函式。 */
    holdGuesses() {
      gate = new Promise((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

/** 讓已經排好的 promise 都跑完（不等計時器）。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

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

describe('toggle（點圖示、快捷鍵）', () => {
  it('沒啟動時點一下就啟動；再點一下就停止、移除覆蓋層並關掉側邊欄', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    await activation.toggle(1);
    expect(await activation.isActive(1)).toBe(true);
    await activation.toggle(1);

    expect(await activation.isActive(1)).toBe(false);
    expect(chrome.calls.stopped).toEqual([1]);
    expect(chrome.calls.closedPanels).toEqual([1]);
  });

  it('Side Panel on Activation 關著：啟動但不打開側邊欄', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.settings.panelOnActivation = false;
    const activation = createActivation(chrome.deps);

    await activation.toggle(1);

    expect(await activation.isActive(1)).toBe(true);
    expect(chrome.calls.openedPanels).toEqual([]);
    expect(chrome.calls.openedIfEnabled).toEqual([]);
  });

  it('設定開著：在任何 await 之前就同步打開側邊欄', () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);

    void activation.toggle(1);

    expect(chrome.calls.openedPanels).toEqual([1]);
  });

  it('SW 剛醒來還沒讀到設定：只同步呼叫 open，交給 Chrome 照同步過去的 enabled 決定', () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.settings.panelOnActivation = undefined;
    const activation = createActivation(chrome.deps);

    void activation.toggle(1);

    expect(chrome.calls.openedIfEnabled).toEqual([1]);
    expect(chrome.calls.openedPanels).toEqual([]);
  });

  it('知道已啟動的 tab 再點一下：不先打開側邊欄', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.toggle(1);

    await activation.toggle(1);

    expect(chrome.calls.openedPanels).toEqual([1]);
  });

  it('啟動當下卡住（例如沒登入）：照常啟動，同時打開 onboarding 並帶入能解決問題的那一步', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.settings.blocked = 'signIn';
    const activation = createActivation(chrome.deps);

    await activation.toggle(1);

    expect(await activation.isActive(1)).toBe(true);
    expect(chrome.calls.onboardings).toEqual([[1, 'signIn']]);
  });

  it('能翻譯就不開 onboarding；停止也不開', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.toggle(1);
    chrome.settings.blocked = 'plan';

    await activation.toggle(1);

    expect(chrome.calls.onboardings).toEqual([]);
  });

  it('e2e 測試入口不開 onboarding（只有點圖示的當下才算）', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.settings.blocked = 'signIn';
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(chrome.calls.onboardings).toEqual([]);
  });

  it('stop()（e2e／debug 的 test:stop）不關側邊欄', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    const activation = createActivation(chrome.deps);
    await activation.toggle(1);

    await activation.stop(1);

    expect(chrome.calls.closedPanels).toEqual([]);
  });
});

describe('openPanel（圖示右鍵的「打開側邊欄」）', () => {
  it('設定關著也打開側邊欄；還沒啟動就順便啟動', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.settings.panelOnActivation = false;
    const activation = createActivation(chrome.deps);

    await activation.openPanel(1);

    expect(chrome.calls.openedPanels).toEqual([1]);
    expect(await activation.isActive(1)).toBe(true);
  });

  it('已啟動就只打開側邊欄，不停止', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.settings.panelOnActivation = false;
    const activation = createActivation(chrome.deps);
    await activation.toggle(1);

    await activation.openPanel(1);

    expect(await activation.isActive(1)).toBe(true);
    expect(chrome.calls.stopped).toEqual([]);
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
    await activation.handleTabUpdated(1, { status: 'complete' });

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

describe('依頁面標題自動歸類（#186）', () => {
  const NEXT_EPISODE = 'https://manga.example/episode/124';

  it('啟動時不等猜原名：先開始擷取，Series 等猜完才決定', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const release = chrome.holdGuesses();
    const activation = createActivation(chrome.deps);

    const activating = activation.activate(1);
    await settle();

    // 已經通知啟動（SW 收到就開始擷取、OCR），猜測還沒回來
    expect(chrome.statusEvents).toEqual([[1, true]]);
    expect(await activation.isActive(1)).toBe(true);
    expect(activation.isSeriesPending(1)).toBe(true);
    const seriesId = activation.getSeriesId(1);
    release();
    await activating;

    expect(await seriesId).toBe('title:範例作品');
    expect(activation.isSeriesPending(1)).toBe(false);
    // side panel 可能在猜完之前就讀過一次，決定後要叫它重讀
    expect(chrome.assigned).toEqual([1]);
  });

  it('猜完、狀態還在寫入時來問的，也拿得到這次的 Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const set = chrome.deps.store.set;
    // 像 IndexedDB 一樣，寫入要過一會兒才完成
    chrome.deps.store.set = (tabId, state) => new Promise((r) => setTimeout(r, 20)).then(() => set(tabId, state));
    const release = chrome.holdGuesses();
    const activation = createActivation(chrome.deps);
    const activating = activation.activate(1);
    await settle();

    const seriesId = activation.getSeriesId(1);
    release();

    expect(await seriesId).toBe('title:範例作品');
    await activating;
  });

  it('網址模式命中時不猜原名', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    chrome.patterns.set(EPISODE, 'series-a');
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.getSeriesId(1)).toBe('series-a');
    expect(chrome.guesses).toEqual([]);
  });

  it('猜原名期間按停止：猜完也不算啟動', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const release = chrome.holdGuesses();
    const activation = createActivation(chrome.deps);
    const activating = activation.activate(1);
    await settle();

    await activation.stop(1);
    release();
    await activating;

    expect(await activation.isActive(1)).toBe(false);
    expect(await activation.getSeriesId(1)).toBeUndefined();
  });

  it('同分頁換網址、標題跟上次一樣：不再猜，沿用目前的 Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    await activation.handleTabUpdated(1, { status: 'loading', url: NEXT_EPISODE });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(chrome.guesses).toEqual(['範例作品']);
    expect(await activation.getSeriesId(1)).toBe('title:範例作品');
  });

  it('同分頁換網址、標題不同：載入完成後重猜；猜到另一部就換過去，Series 決定之前翻譯先等', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.titles[1] = '別的作品';
    await activation.handleTabUpdated(1, { status: 'loading', url: NEXT_EPISODE });
    expect(activation.isSeriesPending(1)).toBe(true);
    const seriesId = activation.getSeriesId(1);
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await seriesId).toBe('title:別的作品');
    expect(chrome.guesses).toEqual(['範例作品', '別的作品']);
    // 新頁面是等 Series 決定後才擷取、翻譯的，不必忘掉重來；只通知 side panel
    expect(chrome.seriesChanges).toEqual([]);
    expect(chrome.assigned).toContain(1);
  });

  it('同分頁換網址、猜不出來：沿用目前的 Series', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.titles[1] = '';
    await activation.handleTabUpdated(1, { status: 'loading', url: NEXT_EPISODE });
    await activation.handleTabUpdated(1, { status: 'complete' });

    expect(await activation.getSeriesId(1)).toBe('title:範例作品');
  });

  it('不重新載入的換網址（SPA）：馬上重猜', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const activation = createActivation(chrome.deps);
    await activation.activate(1);

    chrome.titles[1] = '別的作品';
    await activation.handleTabUpdated(1, { url: NEXT_EPISODE });

    expect(await activation.getSeriesId(1)).toBe('title:別的作品');
  });

  it('記下這次歸類的理由與猜到的原名（side panel 顯示「為什麼歸到這部」、讀者選別部時記原名）', async () => {
    const chrome = fakeChrome({ 1: EPISODE });
    chrome.titles[1] = '範例作品';
    const activation = createActivation(chrome.deps);

    await activation.activate(1);

    expect(await activation.getTab(1)).toMatchObject({ seriesId: 'title:範例作品', by: 'created', originalTitle: '範例作品' });
  });
});
