/**
 * 每個 tab 的啟動狀態（ADR 0003、spec #27 第 3.1 節），以及這個 tab 用哪部 Series（#145、#186）。
 * Chrome API 都從 deps 注入，SW 的 index.ts 負責接上真的 chrome.*。
 *
 * 自動歸類（#186、ADR 0010）：新的啟動先看網址模式，對不上就從頁面標題猜作品原名。猜測跟擷取、OCR 並行：
 * 一啟動就通知（開始擷取），getSeriesId 等猜完才回答，所以翻譯呼叫等兩邊都完成才出發。
 * 同分頁換網址：網址模式命中就換；對不上就在載入完成後重讀標題，跟上次一樣就不猜，不一樣才重猜。
 *
 * 圖示是開關（#185、ADR 0003）：沒啟動就啟動，Side Panel on Activation 開著才一起開 side panel；已啟動就停止並關掉 side panel。
 * 點圖示的當下卡住（沒同意、沒登入、額度 0）照常啟動，同時打開 onboarding 能解決問題的那一步。
 */
import type { RequestedStep } from '../shared/onboarding.ts';
import type { TitleGuess } from '../shared/series.ts';
import { createTrace } from '../shared/trace.ts';
import type { TitleSignals } from '../shared/translator.ts';
import type { SeriesAssignment } from './series-catalog.ts';

const trace = createTrace('sw');

export interface TabState {
  /** 啟動當下的 origin；換 origin 就停止。 */
  origin: string;
  /** 這次啟動的 Series；翻譯快取寫在它的 ID 下。 */
  seriesId: string;
  /** 為什麼是這部（side panel 顯示）；manual＝讀者在 side panel 選的。#186 以前存的狀態沒有。 */
  by?: SeriesAssignment['by'] | 'manual';
  /** 這次猜到的原名：讀者改選別部時記到那部上。 */
  originalTitle?: string;
  /** 上次讀到的頁面標題；同分頁換網址後一樣就不重猜。 */
  titleSignals?: TitleSignals;
}

/** 卡住時 onboarding 要跳到的那一步。 */
export type BlockedStep = RequestedStep;

export interface TabStateStore {
  get(tabId: number): Promise<TabState | undefined>;
  set(tabId: number, state: TabState): Promise<void>;
  delete(tabId: number): Promise<void>;
  /** 全部已啟動的 tab（#214：刪除作品時找出顯示它的 tab）。 */
  entries(): Promise<[number, TabState][]>;
}

export interface ActivationDeps {
  store: TabStateStore;
  getTabUrl(tabId: number): Promise<string | undefined>;
  /**
   * Side Panel on Activation（shared/side-panel-setting.ts）；SW 剛醒來、還沒從 chrome.storage 讀到時是 undefined。
   * 一定要同步回答：sidePanel.open() 要在第一個 await 之前呼叫。
   */
  sidePanelOnActivation(): boolean | undefined;
  /**
   * 打開這個 tab 的 side panel，必須在 user gesture 裡同步呼叫。
   * onlyIfEnabled：設定還沒讀到，只呼叫 open、不把這個 tab 設成 enabled，讓 Chrome 照 SW 同步過去的 enabled 決定開不開。
   */
  openSidePanel(tabId: number, options?: { onlyIfEnabled?: boolean }): Promise<void>;
  /** 圖示當開關、停止時關掉這個 tab 的 side panel（沒開也沒關係）。 */
  closeSidePanel(tabId: number): Promise<void>;
  /** 點圖示的當下卡在哪一步（沒同意、沒登入、額度 0、沒有 key）；能翻譯就是 undefined。 */
  blockedStep(): Promise<BlockedStep | undefined>;
  /** 用新分頁打開能解決問題的那一頁（額度 0 是帳號頁，#213；其他是 onboarding 的那一步）；完成後「回到漫畫」切回 tabId。 */
  openBlockedPage(tabId: number, step: BlockedStep): Promise<void>;
  injectContentScript(tabId: number): Promise<void>;
  stopContentScript(tabId: number): Promise<void>;
  onStatusChanged(tabId: number, active: boolean): void;
  /** 新的啟動要用的 Series：網址模式 → 原名命中 → 新建 Provisional Series（series-catalog.ts）。guess 只在網址模式對不上時呼叫。 */
  seriesForUrl(url: string, guess: () => Promise<TitleGuess | undefined>): Promise<SeriesAssignment>;
  /** 同分頁換網址後重猜到的原名 → Series（命中既有的，或新建 Provisional Series）。 */
  seriesForGuess(guess: TitleGuess): Promise<SeriesAssignment>;
  /** 讀這個 tab 頁面上的標題；讀不到（頁面還沒好、沒權限）是 undefined。 */
  readTitleSignals(tabId: number): Promise<TitleSignals | undefined>;
  /** 從標題猜原名；猜不出來、不能送（沒同意、沒 key）、失敗或逾時都是 undefined。 */
  guessSeries(signals: TitleSignals): Promise<TitleGuess | undefined>;
  /** 同分頁導航到的網址，網址模式記住的 Series；對不上是 undefined（#145）。 */
  rememberedSeries(url: string): Promise<string | undefined>;
  /** 網址模式換了這個 tab 的 Series：快取查詢、Series Notes、Prior Pages 都要改用它（忘掉畫面上的 Page 重新擷取）。 */
  onSeriesChanged(tabId: number, seriesId: string): void;
  /** 自動歸類決定了這個 tab 的 Series（可能沒變）：side panel 重新讀。 */
  onSeriesAssigned(tabId: number): void;
}

/** 換網址後等載入完成最多這麼久；等不到（導航中斷）就照目前的 Series，不讓翻譯一直等。 */
const NAV_GUESS_WAIT_MS = 10_000;

const sameSignals = (a: TitleSignals, b: TitleSignals | undefined) =>
  b !== undefined && a.title === b.title && a.ogTitle === b.ogTitle && a.headings.length === b.headings.length && a.headings.every((h, i) => h === b.headings[i]);

export function createActivation(deps: ActivationDeps) {
  /** 正在決定 Series 的新啟動；stop 時從這裡拿掉，猜完就不寫入。 */
  const starting = new Map<number, Promise<TabState | undefined>>();
  /** 同分頁換網址後正在重猜（或等載入完成才猜）；start 在載入完成時呼叫。 */
  const navigating = new Map<number, { done: Promise<void>; start?: () => void }>();
  /** 這個 SW 看過的啟動狀態，同步回答（toggle 在 user gesture 裡決定要不要開 side panel）；SW 剛醒來是空的。 */
  const knownActive = new Map<number, boolean>();
  const store: TabStateStore = {
    get: async (tabId) => {
      const state = await deps.store.get(tabId);
      knownActive.set(tabId, state !== undefined);
      return state;
    },
    set: async (tabId, state) => {
      knownActive.set(tabId, true);
      await deps.store.set(tabId, state);
    },
    delete: async (tabId) => {
      knownActive.set(tabId, false);
      await deps.store.delete(tabId);
    },
    entries: () => deps.store.entries(),
  };

  /** 新的啟動還在猜時先等它（同一個 tab 的事件與再點一次圖示都要看到它的結果）。 */
  async function currentState(tabId: number): Promise<TabState | undefined> {
    const pending = starting.get(tabId);
    if (pending) {
      const state = await pending;
      // 猜完了、狀態還在寫進 store：直接用這次的結果（store 可能還讀不到）。期間按了停止就已經不在 starting 裡
      if (starting.get(tabId) === pending) return state;
    }
    return store.get(tabId);
  }

  /**
   * 依 Side Panel on Activation 打開 side panel。必須在第一個 await 之前呼叫，否則 Chrome 認為已離開 user gesture。
   * 測試入口沒有 user gesture，這裡一定失敗；side panel 打不開不影響啟動。
   */
  function openPanelOnActivation(tabId: number): void {
    const setting = deps.sidePanelOnActivation();
    if (setting === false) return;
    deps.openSidePanel(tabId, setting === undefined ? { onlyIfEnabled: true } : {}).catch((e: unknown) => console.warn('sidePanel.open failed', e));
  }

  /** e2e 測試入口（等同點圖示啟動，但已啟動時不停止）。 */
  async function activate(tabId: number): Promise<void> {
    openPanelOnActivation(tabId);
    await start(tabId);
  }

  /**
   * 點圖示／快捷鍵：沒啟動就啟動（設定開著就一起開 side panel），已啟動就停止並關掉 side panel。
   * 已啟動的 tab 這時不開 side panel；SW 剛醒來還不知道（knownActive 沒有）就照沒啟動處理，查到已啟動再關掉。
   */
  async function toggle(tabId: number): Promise<void> {
    if (knownActive.get(tabId) !== true) openPanelOnActivation(tabId);
    if (await isActive(tabId)) {
      await stop(tabId);
      await deps.closeSidePanel(tabId).catch(() => {});
      return;
    }
    await startFromGesture(tabId);
  }

  /** 點圖示（或快捷鍵、右鍵「打開側邊欄」）的新啟動。 */
  async function startFromGesture(tabId: number): Promise<void> {
    // 卡住（沒同意、沒登入、額度 0）時照常啟動，同時打開 onboarding；跟決定 Series 一起進行，不等它
    const blocked = deps.blockedStep().catch(() => undefined);
    let started!: () => void;
    const activated = new Promise<void>((resolve) => (started = resolve));
    const onboarding = Promise.all([blocked, activated]).then(async ([step]) => {
      if (step && (await isActive(tabId))) await deps.openBlockedPage(tabId, step).catch((e: unknown) => console.warn('open blocked page failed', e));
    });
    await start(tabId, started);
    // 沒啟動成功（注入失敗）就不等 onboarding
    if (await isActive(tabId)) await onboarding;
  }

  /** 圖示右鍵的「打開側邊欄」：不管設定一律打開（同步，user gesture），還沒啟動就順便啟動。 */
  async function openPanel(tabId: number): Promise<void> {
    deps.openSidePanel(tabId).catch((e: unknown) => console.warn('sidePanel.open failed', e));
    if (!(await isActive(tabId))) await startFromGesture(tabId);
  }

  /** onStarted：新的啟動開始擷取的當下（不等 Series 決定）。 */
  async function start(tabId: number, onStarted?: () => void): Promise<void> {
    const url = await deps.getTabUrl(tabId);
    if (url === undefined) return;
    if (!(await tryInject(tabId))) return;
    // 已啟動的 tab 再啟動一次（測試入口、或 toggle 判斷時剛好啟動完成）不算新的啟動，沿用同一個 Series。
    const existing = await currentState(tabId);
    if (existing) {
      trace('activate', { tabId, seriesId: existing.seriesId, reused: true });
      await store.set(tabId, existing);
      deps.onStatusChanged(tabId, true);
      return;
    }
    const origin = new URL(url).origin;
    const signals = deps.readTitleSignals(tabId).catch(() => undefined);
    const deciding = (async (): Promise<TabState> => {
      const assigned = await deps.seriesForUrl(url, async () => {
        const read = await signals;
        return read && deps.guessSeries(read);
      });
      const titleSignals = await signals;
      return { origin, ...assigned, ...(titleSignals ? { titleSignals } : {}) };
    })();
    // 歸到哪部、為什麼記在 series:forUrl
    const settled = deciding.then(
      (state) => state,
      () => undefined,
    );
    starting.set(tabId, settled);
    // 不等 Series：先開始擷取與 OCR，翻譯在 getSeriesId 等它（#186）
    deps.onStatusChanged(tabId, true);
    onStarted?.();
    const state = await settled;
    // 期間按了停止（或換 origin、關 tab）：不算啟動
    if (starting.get(tabId) !== settled) return;
    if (state) await store.set(tabId, state);
    starting.delete(tabId);
    trace('activate', { tabId, seriesId: state?.seriesId, reused: false });
    if (!state) await markInactive(tabId);
    else deps.onSeriesAssigned(tabId);
  }

  async function isActive(tabId: number): Promise<boolean> {
    return starting.has(tabId) || (await store.get(tabId)) !== undefined;
  }

  /** 這個 tab 的 Series 還沒決定（啟動或換網址後正在猜）。 */
  function isSeriesPending(tabId: number): boolean {
    return starting.has(tabId) || navigating.has(tabId);
  }

  /** 這個 tab 的狀態；Series 正在決定時等它決定。 */
  async function getTab(tabId: number): Promise<TabState | undefined> {
    const state = await currentState(tabId);
    const nav = navigating.get(tabId);
    if (!state || !nav) return state;
    await nav.done;
    return store.get(tabId);
  }

  async function getSeriesId(tabId: number): Promise<string | undefined> {
    return (await getTab(tabId))?.seriesId;
  }

  /** side panel 選了別的 Series（或合併後改用目標）：之後的快取查詢與翻譯都用它。沒啟動就不動。 */
  async function setSeriesId(tabId: number, seriesId: string): Promise<void> {
    const state = await currentState(tabId);
    if (state) await store.set(tabId, { ...state, seriesId, by: state.seriesId === seriesId ? state.by : 'manual' });
  }

  async function tryInject(tabId: number): Promise<boolean> {
    try {
      await deps.injectContentScript(tabId);
      return true;
    } catch (e) {
      console.warn('content script injection failed', e);
      return false;
    }
  }

  /** 只清掉啟動狀態；通知 content script 結束是 stop() 的事。 */
  async function markInactive(tabId: number): Promise<void> {
    starting.delete(tabId);
    navigating.get(tabId)?.start?.();
    await store.delete(tabId);
    deps.onStatusChanged(tabId, false);
  }

  /** 每個 tab 正在處理的 onUpdated 事件，後到的排在它後面。 */
  const tabUpdates = new Map<number, Promise<void>>();

  /**
   * 對應 chrome.tabs.onUpdated 的 changeInfo。
   * Chrome 不等 listener 的 promise，同一個 tab 的事件要排隊：否則換 origin 那個還在清狀態時，
   * 載入完成那個先讀到舊狀態，就把 content script 注入到新 origin。
   */
  function handleTabUpdated(tabId: number, change: { url?: string; status?: string }): Promise<void> {
    // 前一個失敗也照樣處理這一個
    const previous = tabUpdates.get(tabId)?.catch(() => {}) ?? Promise.resolve();
    const next = previous.then(() => applyTabUpdate(tabId, change));
    tabUpdates.set(tabId, next);
    const forget = () => {
      if (tabUpdates.get(tabId) === next) tabUpdates.delete(tabId);
    };
    next.then(forget, forget);
    return next;
  }

  async function applyTabUpdate(tabId: number, change: { url?: string; status?: string }): Promise<void> {
    const state = await currentState(tabId);
    if (!state) return;
    if (change.url !== undefined && new URL(change.url).origin !== state.origin) {
      await markInactive(tabId);
      return;
    }
    // 網址模式對不上：完整載入的等載入完成才讀標題；不重新載入的（SPA）馬上讀
    if (change.url !== undefined && !(await followSeries(tabId, state, change.url))) guessAfterNavigation(tabId, change.status !== 'loading');
    if (change.status === 'complete') {
      // 重新注入失敗通常是 activeTab 授權已失效，只能等使用者再點一次圖示。
      if (!(await tryInject(tabId))) await markInactive(tabId);
      else navigating.get(tabId)?.start?.();
    }
  }

  /**
   * 同分頁換作品（#145）：網址模式記住了另一部 Series 就換。回傳網址模式有沒有命中（命中同一部也算）。
   */
  async function followSeries(tabId: number, state: TabState, url: string): Promise<boolean> {
    const remembered = await deps.rememberedSeries(url);
    if (remembered === undefined) return false;
    if (remembered === state.seriesId) return true;
    trace('series:navigate', { tabId, from: state.seriesId, seriesId: remembered, by: 'urlPattern' });
    await store.set(tabId, { ...state, seriesId: remembered, by: 'urlPattern' });
    deps.onSeriesChanged(tabId, remembered);
    return true;
  }

  /**
   * 換網址後重讀標題（#186）。重猜期間 getSeriesId 等它，新頁面的翻譯用重猜的結果，所以換了 Series 也不必重新擷取。
   * 已經在等的就不再排一個（載入完成時讀到的就是最新的頁面）。
   */
  function guessAfterNavigation(tabId: number, now: boolean): void {
    if (navigating.has(tabId)) return;
    let start!: () => void;
    const loaded = new Promise<void>((resolve) => (start = resolve));
    const timer = setTimeout(start, NAV_GUESS_WAIT_MS);
    const entry: { done: Promise<void>; start?: () => void } = { done: Promise.resolve() };
    entry.done = loaded
      .then(() => {
        clearTimeout(timer);
        entry.start = undefined;
        return reguess(tabId);
      })
      .catch((e: unknown) => console.warn('series guess after navigation failed', e))
      .finally(() => {
        if (navigating.get(tabId) === entry) navigating.delete(tabId);
      });
    entry.start = start;
    navigating.set(tabId, entry);
    if (now) start();
  }

  /** 標題跟上次一樣就不猜（避免 SPA 的舊 metadata，也省一次呼叫）；猜到另一部就換過去，猜不出來就沿用目前的。 */
  async function reguess(tabId: number): Promise<void> {
    const state = await store.get(tabId);
    if (!state) return;
    const signals = await deps.readTitleSignals(tabId).catch(() => undefined);
    if (!signals || sameSignals(signals, state.titleSignals)) {
      trace('series:reguess', { tabId, skipped: signals ? 'sameSignals' : 'noSignals' });
      return;
    }
    await store.set(tabId, { ...state, titleSignals: signals });
    const guess = await deps.guessSeries(signals);
    const latest = await store.get(tabId);
    if (!guess || !latest) {
      trace('series:reguess', { tabId, skipped: guess ? 'stopped' : 'unknown' });
      return;
    }
    const assigned = await deps.seriesForGuess(guess);
    await store.set(tabId, { ...latest, ...assigned });
    if (assigned.seriesId !== latest.seriesId) trace('series:navigate', { tabId, from: latest.seriesId, ...assigned });
    deps.onSeriesAssigned(tabId);
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    starting.delete(tabId);
    navigating.get(tabId)?.start?.();
    await store.delete(tabId);
  }

  /** 停止但不關 side panel（e2e／debug 的 test:stop）。 */
  async function stop(tabId: number): Promise<void> {
    await markInactive(tabId);
    // 頁面可能已經關掉或換頁，content script 不在也沒關係。
    await deps.stopContentScript(tabId).catch(() => {});
  }

  /**
   * 刪除作品（#214）：停用所有顯示這部作品的 tab（還在決定 Series 的等它決定），側邊欄不關，讓它顯示「已刪除」。
   * 回傳停用了哪些 tab。
   */
  async function stopSeries(seriesId: string): Promise<number[]> {
    const tabIds = new Set([...(await store.entries()).map(([tabId]) => tabId), ...starting.keys()]);
    const stopped: number[] = [];
    for (const tabId of tabIds) {
      if ((await getTab(tabId))?.seriesId !== seriesId) continue;
      await stop(tabId);
      stopped.push(tabId);
    }
    trace('series:stopTabs', { seriesId, tabIds: stopped });
    return stopped;
  }

  return { activate, toggle, openPanel, stop, stopSeries, isActive, isSeriesPending, getTab, getSeriesId, setSeriesId, handleTabUpdated, handleTabRemoved };
}
