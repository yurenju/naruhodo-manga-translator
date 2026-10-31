/**
 * 找 Page → 截圖 → 裁切（spec #27 第 3.2 節）。
 * Chrome API 與其他 context 都從 deps 注入，SW 的 index.ts 負責接上真的 chrome.*。
 */
import type { CropRequest, PageCandidate, PageCandidatesResponse, PageThumb } from '../shared/messages.ts';
import { findSamePage } from '../shared/page-hash.ts';
import { createTrace } from '../shared/trace.ts';

const trace = createTrace('sw');

/**
 * 兩次 captureVisibleTab 之間至少隔這麼久。Chrome 限制每個外掛最多 2 次/秒，超過會直接丟錯（#4）；
 * 多留 50 ms 給 SW 與瀏覽器之間的 IPC 時間差。
 */
export const CAPTURE_INTERVAL_MS = 550;

/** 版面一直在變（例如持續捲動）時最多試幾次，之後放棄，等下一次觸發。 */
const MAX_ATTEMPTS = 3;

export interface ScannerDeps {
  findPageCandidates(tabId: number): Promise<PageCandidatesResponse>;
  /** tab 是它視窗裡的作用中 tab 就回傳 windowId；否則 undefined（captureVisibleTab 只截得到作用中 tab）。 */
  getVisibleWindowId(tabId: number): Promise<number | undefined>;
  /**
   * 截圖前：讓頁面持續重繪（#60）、藏起疊在 Page 上的網站元素（工具列、翻頁感應區，#59），hideOverlay 時
   * 也藏自己的覆蓋層（shadow host）；等到瀏覽器重繪完才 resolve（spec #27 第 3.2 節）。
   */
  prepareCapture(tabId: number, hideOverlay: boolean): Promise<void>;
  /** 截完立刻還原。stable＝false：藏起來的元素在截圖期間被換掉，截圖不能用。 */
  finishCapture(tabId: number): Promise<{ stable: boolean }>;
  /** 截圖。要在呼叫當下就送出 captureVisibleTab，限速是以呼叫的時間計算。 */
  captureWindow(windowId: number): Promise<string>;
  crop(request: CropRequest): Promise<PageThumb[]>;
  /** capture＝這次的截圖與版面（沒有 Page 或停止時是 undefined），給後面的本機流水線裁全解析度的 Page。 */
  publish(tabId: number, pages: PageThumb[], capture?: CropRequest): void;
}

export function createScanner(deps: ScannerDeps) {
  const pages = new Map<number, PageThumb[]>();
  /** 每個 tab：anchor → 覆蓋層顯示著哪一頁、那時帶覆蓋層截到的 hash。 */
  const overlaidLooks = new Map<number, Map<string, { pageHash: string; overlaidHash: string }>>();
  /** 每個 tab 排著、還沒開始的那次掃描。 */
  const pendingScans = new Map<number, Promise<void>>();
  /** clear() 就加一；掃描開始時記下來，做完時不同就丟掉結果。 */
  const generations = new Map<number, number>();
  /** 掃描一次只跑一個（跨 tab），限速才算得準。 */
  let queue: Promise<void> = Promise.resolve();
  let lastCaptureAt = -Infinity;

  async function waitForCaptureAllowed(): Promise<void> {
    const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /** 截圖前後量到的版面一樣，才能確定 rect 對得上截圖。 */
  function sameLayout(a: PageCandidatesResponse, b: PageCandidatesResponse): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** 覆蓋層顯示中的 anchor 上面是哪個 Page。 */
  const shownPage = (c: PageCandidate) => (c.overlaid?.length === 1 ? c.overlaid[0] : undefined);
  /** 長 Page（c.visible）不算：它的覆蓋層截圖時本來就不藏，身分也不靠 hash（spec #142）。 */
  const withOverlay = (candidates: PageCandidate[]) => candidates.filter((c) => !c.visible && (c.overlaid?.length ?? 0) > 0);

  /** 覆蓋層顯示中的 anchor 都記過帶覆蓋層的樣子，這次就不必藏覆蓋層。 */
  function canKeepOverlay(tabId: number, candidates: PageCandidate[]): boolean {
    const looks = overlaidLooks.get(tabId);
    const shown = withOverlay(candidates);
    // 一個 anchor 顯示兩頁（Spread）沒有記錄可比：shownPage 是 undefined，不能拿去跟沒記錄的 undefined 比成相同（#55）
    return shown.length > 0 && shown.every((c) => {
      const page = shownPage(c);
      return page !== undefined && looks?.get(c.anchorId)?.pageHash === page;
    });
  }

  /** 帶覆蓋層截到的 hash 換回原圖的；對不上（覆蓋層底下換頁了）回傳 undefined。 */
  function toCleanPages(tabId: number, candidates: PageCandidate[], pages: PageThumb[]): PageThumb[] | undefined {
    const looks = overlaidLooks.get(tabId);
    const result: PageThumb[] = [];
    for (const page of pages) {
      const candidate = candidates.find((c) => c.anchorId === page.anchorId);
      const look = candidate && shownPage(candidate) !== undefined ? looks?.get(page.anchorId) : undefined;
      if (!look) result.push(page);
      else if (findSamePage([{ pageHash: look.overlaidHash }], page.pageHash)) result.push({ ...page, pageHash: look.pageHash });
      else {
        looks!.delete(page.anchorId);
        trace('overlaid:mismatch', { tabId, anchorId: page.anchorId, pageHash: page.pageHash, overlaidHash: look.overlaidHash });
        return undefined;
      }
    }
    return result;
  }

  /** 截圖前後的準備一律做（藏網站的遮擋物）；hideOverlay 決定要不要連自己的覆蓋層一起藏。 */
  async function capture(windowId: number, tabId: number, hideOverlay: boolean): Promise<{ screenshot: string; stable: boolean }> {
    let screenshot: string;
    try {
      await deps.prepareCapture(tabId, hideOverlay);
      lastCaptureAt = Date.now();
      screenshot = await deps.captureWindow(windowId);
    } catch (e) {
      // 還原失敗（例如 content script 已經斷線）不蓋掉原本的錯誤
      await deps.finishCapture(tabId).catch(() => {});
      throw e;
    }
    const { stable } = await deps.finishCapture(tabId);
    return { screenshot, stable };
  }

  async function scanOnce(tabId: number, generation: number): Promise<void> {
    const isCurrentGeneration = () => (generations.get(tabId) ?? 0) === generation;
    let forceHide = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 等完才量 rect，rect 才不會在等待期間過時。
      await waitForCaptureAllowed();
      if (!isCurrentGeneration()) return;
      const before = await deps.findPageCandidates(tabId);
      if (before.candidates.length === 0) {
        trace('scan:noCandidates', { tabId });
        if (!isCurrentGeneration()) return;
        publish(tabId, []);
        return;
      }
      const windowId = await deps.getVisibleWindowId(tabId);
      if (windowId === undefined) {
        trace('scan:notActiveTab', { tabId });
        return;
      }
      // 截圖會截到自己的覆蓋層，hash 就跟原圖對不上；所以截圖期間先藏起來。真實 Chrome 截一次約 0.25 秒（#60），
      // 藏著的這段時間中文會閃回日文；已經記過帶覆蓋層樣子的 Page 就不藏，改用那個樣子認。網站疊在 Page 上的
      // 元素（工具列等）不管哪一種都藏（#59）。
      const keep = !forceHide && canKeepOverlay(tabId, before.candidates);
      const { screenshot, stable } = await capture(windowId, tabId, !keep);
      // side panel 剛打開造成重排、使用者在截圖時捲動、藏起來的元素被換掉（藏不到新的）……截圖不可靠就重來。
      if (!stable) {
        trace('scan:occludersChanged', { tabId, attempt });
        continue;
      }
      if (!sameLayout(before, await deps.findPageCandidates(tabId))) {
        trace('scan:layoutChanged', { tabId, attempt });
        continue;
      }
      const request: CropRequest = { screenshot, ...before };
      const cropped = await deps.crop(request);
      const result = keep ? toCleanPages(tabId, before.candidates, cropped) : cropped;
      if (!result) {
        forceHide = true;
        attempt--;
        continue;
      }
      if (!isCurrentGeneration()) return;
      publish(tabId, result, request);
      // 覆蓋層顯示中卻還沒記過樣子（例如重新整理後從快取顯示）：補記，下次就不必藏
      if (!keep && withOverlay(before.candidates).length > 0 && !canKeepOverlay(tabId, before.candidates)) void recordOverlaid(tabId);
      return;
    }
    throw new Error(`layout kept changing during capture (tab ${tabId})`);
  }

  /**
   * 覆蓋層畫好之後：不藏覆蓋層截一次（網站的遮擋物照樣藏），記下每個顯示中的 Page「帶覆蓋層的樣子」（hash）。不公布。
   * 只記上次截圖確實看到同一頁的 anchor，免得覆蓋層底下剛好換頁時把錯的頁配上去。
   */
  async function recordOnce(tabId: number, generation: number): Promise<void> {
    const isCurrentGeneration = () => (generations.get(tabId) ?? 0) === generation;
    await waitForCaptureAllowed();
    if (!isCurrentGeneration()) return;
    const before = await deps.findPageCandidates(tabId);
    const seen = pages.get(tabId) ?? [];
    const recorded = overlaidLooks.get(tabId);
    const shown = withOverlay(before.candidates).filter((c) => {
      const page = shownPage(c);
      // 已經記過同一頁（例如翻回來命中快取、覆蓋層重畫）就不必再截
      if (page === undefined || recorded?.get(c.anchorId)?.pageHash === page) return false;
      // 樣子以 anchor 為單位記；切成兩頁的 Spread 分不出截到的是哪一頁，不記（截圖時照舊藏覆蓋層）
      const onAnchor = seen.filter((p) => p.anchorId === c.anchorId);
      return onAnchor.length === 1 && findSamePage(onAnchor, page) !== undefined;
    });
    if (shown.length === 0) return;
    const windowId = await deps.getVisibleWindowId(tabId);
    if (windowId === undefined) return;
    const { screenshot, stable } = await capture(windowId, tabId, false);
    if (!stable || !sameLayout(before, await deps.findPageCandidates(tabId)) || !isCurrentGeneration()) return;
    const cropped = await deps.crop({ screenshot, viewport: before.viewport, candidates: shown });
    if (!isCurrentGeneration()) return;
    let looks = overlaidLooks.get(tabId);
    if (!looks) overlaidLooks.set(tabId, (looks = new Map()));
    for (const page of cropped) {
      const pageHash = shownPage(shown.find((c) => c.anchorId === page.anchorId)!)!;
      looks.set(page.anchorId, { pageHash, overlaidHash: page.pageHash });
    }
    if (__E2E__) globalThis.__overlaidRecords = (globalThis.__overlaidRecords ?? 0) + cropped.length;
    trace('overlaid:record', { tabId, looks: cropped.map((p) => ({ anchorId: p.anchorId, overlaidHash: p.pageHash })) });
  }

  function publish(tabId: number, result: PageThumb[], capture?: CropRequest): void {
    pages.set(tabId, result);
    deps.publish(tabId, result, capture);
  }

  /**
   * 同一個 tab 已經有排著、還沒開始的掃描就併進去：快速連按翻頁時每個訊號各排一次，停下後會一張接一張
   * 截上好幾秒（真實 Chrome 一次約 0.25 秒，#60 之前要 1～2 秒）。還沒開始的那次會量到最新的版面，所以合併不會漏掉翻頁。
   */
  function scan(tabId: number): Promise<void> {
    const pending = pendingScans.get(tabId);
    if (pending) return pending;
    const generation = generations.get(tabId) ?? 0;
    const task = queue.then(() => {
      pendingScans.delete(tabId);
      return scanOnce(tabId, generation);
    });
    pendingScans.set(tabId, task);
    queue = task.catch(() => {});
    return task;
  }

  function getPages(tabId: number): PageThumb[] {
    return pages.get(tabId) ?? [];
  }

  /** 停止或關 tab 時呼叫。 */
  function clear(tabId: number): void {
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    pages.delete(tabId);
    overlaidLooks.delete(tabId);
    pendingScans.delete(tabId);
    deps.publish(tabId, []);
  }

  /** 覆蓋層畫好後呼叫（content:overlayShown）；跟掃描排同一條隊，限速才算得準。 */
  function recordOverlaid(tabId: number): Promise<void> {
    const generation = generations.get(tabId) ?? 0;
    const task = queue.then(() => recordOnce(tabId, generation));
    queue = task.catch(() => {});
    return task;
  }

  return { scan, recordOverlaid, getPages, clear };
}
