import type { CaptureFinishedResponse, Message, PageCandidate, PageCandidatesResponse, Rect } from '../shared/messages.ts';
import { loadPageMode, onPageModeChange } from '../shared/page-mode.ts';
import { createTrace } from '../shared/trace.ts';
import { createCapturePrep } from './capture.ts';
import { createOverlay, HOST_ATTRIBUTE, isShown, untilRepainted } from './overlay.ts';
import { createOverlayFontLoader } from './overlay-font.ts';
import { longPageVisible, pageCandidateRejection } from './page-candidates.ts';
import { watchPageTurns } from './page-turn.ts';
import { stopRepaint } from './repaint.ts';

/**
 * 由 SW 以 scripting.executeScript 動態注入（沒有靜態 content_scripts）。
 * 跑在 isolated world：這裡的 globalThis 跟頁面的 window 分開，頁面看不到。
 */
declare global {
  var __naruhodo: { active: true } | undefined;
  /** e2e build 才有：每次截圖時覆蓋層被藏了多久（ms），給測試量閃爍時間。 */
  var __overlayHiddenMs: number[] | undefined;
}

// 同一頁可能被注入多次（例如重新整理事件重複），只啟動一次。
if (!globalThis.__naruhodo) {
  globalThis.__naruhodo = { active: true };
  const trace = createTrace('content');

  /**
   * anchor：最近一次量到的 Page 候選元素，之後的覆蓋層靠 id 找回元素。每次重量就重建，
   * 翻頁後被拿掉的元素才不會一直留著。同一個元素一直用同一個 id（WeakMap 不擋回收）。
   */
  const anchors = new Map<string, Element>();
  const anchorIds = new WeakMap<Element, string>();
  let nextAnchorId = 1;
  /** 最近一次量到的長 Page（spec #142）：截圖時不藏它們的覆蓋層，不然每次捲動停下中文都會閃回日文。 */
  const longAnchors = new Set<Element>();

  function anchorIdOf(element: Element): string {
    let id = anchorIds.get(element);
    if (id === undefined) {
      id = `a${nextAnchorId++}`;
      anchorIds.set(element, id);
    }
    anchors.set(id, element);
    return id;
  }

  function findPageCandidates(): PageCandidatesResponse {
    // 完整可見用 clientWidth/Height（不含捲軸）判斷；換算截圖倍率用 innerWidth/Height，
    // 因為 captureVisibleTab 截的是含捲軸的整個可視區域。
    const visible = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const candidates: PageCandidate[] = [];
    /** 除錯記錄用：夠大但不算候選的元素（太小的只算數量，圖示太多）。 */
    const rejected: { tag: string; rect: Rect; reason: string; clips: Rect[] }[] = [];
    let small = 0;
    anchors.clear();
    longAnchors.clear();
    for (const element of document.querySelectorAll('img, canvas')) {
      const { x, y, width, height } = element.getBoundingClientRect();
      const rect = { x, y, width, height };
      const clips = clipRects(element);
      const shown = isShown(element);
      // 比可見範圍高的長 Page 只處理看得到的那一截（spec #142）；其他照「完整可見」的規則
      const slice = shown ? longPageVisible(rect, visible, clips) : undefined;
      // 被工具列之類蓋住的照樣算：截圖前會把蓋在上面的元素藏起來（#59、ADR 0004）。
      // 藏起來的不算：疊在看得到的那張底下，截到的是上面那張，譯文會被貼到兩張上
      const reason = !shown ? 'hidden' : slice ? undefined : pageCandidateRejection(rect, visible, clips);
      if (reason === undefined) {
        const overlaid = overlay.shownPages(element);
        if (slice) longAnchors.add(element);
        const covered = slice ? overlay.coveredRects(element) : [];
        candidates.push({
          anchorId: anchorIdOf(element),
          rect,
          ...(slice ? { visible: slice } : {}),
          ...(covered.length > 0 ? { covered } : {}),
          ...(overlaid.length > 0 ? { overlaid } : {}),
        });
      }
      else if (__DEBUG__ && reason === 'small') small++;
      else if (__DEBUG__) rejected.push({ tag: element.tagName.toLowerCase(), rect, reason, clips });
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (__DEBUG__) trace('candidates', { url: location.href, viewport, visible, dpr: devicePixelRatio, candidates, rejected, small });
    return { viewport, candidates };
  }

  /** 會裁切內容的祖先（overflow 不是 visible）：翻頁式 viewer 的隔壁頁在它外面。 */
  function clipRects(element: Element): Rect[] {
    const clips: Rect[] = [];
    for (let el = element.parentElement; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const { x, y, width, height } = el.getBoundingClientRect();
      clips.push({ x, y, width, height });
    }
    return clips;
  }

  /**
   * 送訊息給 SW；SW 停止或重新載入時送不到，忽略。外掛重新載入或更新後這個 content script 就斷線了
   * （chrome.runtime.id 變 undefined），sendMessage 會同步丟錯、.catch 接不到 → 自己收掉（#40）。
   */
  function send(message: Message): Promise<unknown> {
    if (!chrome.runtime?.id) {
      stop();
      return Promise.resolve();
    }
    return chrome.runtime.sendMessage(message).catch(() => {});
  }

  const overlay = createOverlay({
    loadFont: createOverlayFontLoader(),
    // 頁面 hover → side panel 高亮那行（panel 用 sender.tab 分辨是哪個 tab）
    onHover(line) {
      void send({ type: 'content:hover', line });
    },
  });

  // Page Mode 是全域設定，content script 自己讀、自己聽變更（side panel 切換時立刻跟著變）。
  // 讀到之前不畫覆蓋層：學習時不能先用預設的閱讀閃一下譯文
  const pageModeLoaded = loadPageMode().then((mode) => overlay.setPageMode(mode));
  const stopWatchingPageMode = onPageModeChange(pageModeLoaded, (mode) => {
    overlay.setPageMode(mode);
    // 切回閱讀：譯文重新出現，跟剛畫好時一樣讓 SW 記下帶覆蓋層的樣子，下次截圖就不必藏
    if (mode === 'read') void untilRepainted().then(() => send({ type: 'content:overlayShown' }));
  });

  /** 在自己的覆蓋層（shadow host）裡。 */
  const inOverlayHost = (el: Element) => el.closest(`[${HOST_ATTRIBUTE}]`) !== null;
  const capturePrep = createCapturePrep({ overlay, anchors: () => [...anchors.values()], longAnchors, isOwn: inOverlayHost });

  // 翻頁訊號 → SW 截圖比對 hash（#34）。
  // 覆蓋層改過 position 的父元素，之後它的 style 變動一律當成自己的（頁面改它的 style 會漏掉，接受）
  const isOwn = (node: Node, attribute?: string) =>
    node instanceof Element && (inOverlayHost(node) || (attribute === 'style' && overlay.ownsStyleOf(node)));
  // 還沒量到任何 Page（剛啟動、上次沒有完整可見的 Page）時一律算，免得漏掉第一頁
  const relatesToPage = (node: Node, added: boolean) => {
    if (anchors.size === 0) return true;
    for (const anchor of anchors.values()) if (node.contains(anchor) || anchor.contains(node)) return true;
    return added && node instanceof Element && (node.matches('img, canvas') || node.querySelector('img, canvas') !== null);
  };
  const stopWatching = watchPageTurns({
    notify(reasons) {
      trace('pageTurn', { reasons });
      void send({ type: 'content:pageTurn' });
    },
    isOwn,
    relatesToPage,
    document,
    window,
    MutationObserver,
  });

  const onMessage = (message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean => {
    switch (message.type) {
      case 'content:findPageCandidates':
        sendResponse(findPageCandidates());
        return false;
      case 'content:showOverlay': {
        // anchor 不在最近一次量到的 Page 裡（已經捲走或換頁）就不覆蓋
        const anchor = anchors.get(message.anchorId);
        if (anchor instanceof HTMLElement)
          pageModeLoaded
            .then(() => overlay.show(anchor, message.subRect, message.text, message.pageHash))
            .then(() => send({ type: 'content:overlayShown' }))
            .catch((e: unknown) => console.warn('overlay failed', e));
        else trace('overlay:skip', { anchorId: message.anchorId, pageHash: message.pageHash, reason: 'anchor 不在最近一次量到的 Page 裡' });
        return false;
      }
      case 'content:prepareCapture':
        void capturePrep.prepare(message.hideOverlay).then(() => sendResponse(null));
        return true;
      case 'content:finishCapture': {
        const { stable, overlayHiddenMs } = capturePrep.finish();
        trace('capture:finish', { stable, overlayHiddenMs });
        if (__E2E__ && overlayHiddenMs !== undefined) (globalThis.__overlayHiddenMs ??= []).push(overlayHiddenMs);
        sendResponse({ stable } satisfies CaptureFinishedResponse);
        return false;
      }
      case 'content:highlight':
        overlay.highlight(message.line);
        return false;
      case 'content:stop':
        stop();
        return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);

  /** 停止後頁面要跟沒裝外掛時一樣（#40 驗收 I1）。 */
  function stop() {
    chrome.runtime.onMessage.removeListener(onMessage);
    stopWatching();
    stopWatchingPageMode();
    stopRepaint();
    overlay.clear();
    anchors.clear();
    longAnchors.clear();
    globalThis.__naruhodo = undefined;
    trace('content:stop', { overlaysLeft: document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).length });
  }
}
