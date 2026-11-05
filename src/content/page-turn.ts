/**
 * 翻頁偵測的前半段（spec #27 第 3.2 節）：DOM mutation／scroll／resize／按鍵／點擊／img load
 * → debounce → 通知 SW 截圖。真的有沒有翻頁由 SW 比對每個 Page 的 hash 決定。不做定時輪詢。
 * 截圖期間覆蓋層要藏起來，而真實 Chrome 的 captureVisibleTab 約 0.25 秒（#60 實測），
 * 所以明顯不是翻頁的訊號（只按修飾鍵、跟 Page 無關的元素變動）先在這裡擋掉。
 */

/** 事件停下這麼久才截圖：翻頁動畫（仿 canvas 網站 450 ms，結束時有 transitionend）跑完、捲動停下。 */
export const PAGE_TURN_DEBOUNCE_MS = 400;

export interface PageTurnSignalDeps {
  /** reasons＝debounce 期間收到的訊號（debug build 才收集，其他 build 是空陣列）。 */
  notify(reasons: string[]): void;
  delayMs?: number;
}

export function createPageTurnSignal({ notify, delayMs = PAGE_TURN_DEBOUNCE_MS }: PageTurnSignalDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const reasons = new Set<string>();
  return {
    fire(reason?: string): void {
      if (cancelled) return;
      if (__DEBUG__ && reason !== undefined) reasons.add(reason);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const fired = [...reasons];
        reasons.clear();
        notify(fired);
      }, delayMs);
    },
    cancel(): void {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

const EVENTS = ['scroll', 'keydown', 'click', 'load', 'transitionend', 'animationend'] as const;
/** 目標要跟 Page 有關才算的事件：網站自己的選單動畫、廣告圖片載入不算翻頁。 */
const PAGE_TARGET_EVENTS = new Set<string>(['load', 'transitionend', 'animationend']);
const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'AltGraph', 'OS']);

/** alt-tab 的 Alt、複製貼上這類按鍵不會翻頁；Shift＋空白鍵（上一頁）仍算。 */
function isModifierKeydown(event: Event): boolean {
  const e = event as Partial<KeyboardEvent>;
  return (e.key !== undefined && MODIFIER_KEYS.has(e.key)) || e.altKey === true || e.ctrlKey === true || e.metaKey === true;
}

type Listeners = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface PageTurnWatchDeps extends PageTurnSignalDeps {
  /**
   * 自己造成的變動：覆蓋層（shadow host）的插入、截圖前後切換 visibility，以及覆蓋層把父元素改成
   * relative（attribute＝'style'）。這些不算翻頁，不然每次覆蓋或截圖都會再觸發一次截圖。
   */
  isOwn(node: Node, attribute?: string): boolean;
  /**
   * 這個節點跟 Page 有關：包住或就是 Page 候選、在 Page 裡面；added＝新加入的節點（包著新的 img／canvas 也算）。
   * 跟 Page 無關的變動與事件（網站的選單收合、廣告）不算翻頁，否則每次都白截一次圖、覆蓋層閃掉約 1 秒。
   */
  relatesToPage(node: Node, added: boolean): boolean;
  /** 頁面的 document：事件用 capture 掛在它上面，MutationObserver 看 documentElement。 */
  document: Listeners & { documentElement: Node; visibilityState: DocumentVisibilityState };
  /** resize 掛在 window 上。 */
  window: Listeners;
  MutationObserver: new (callback: MutationCallback) => Pick<MutationObserver, 'observe' | 'disconnect'>;
}

/** trace 用：「mutation:<屬性或 childList>:<tag>.<第一個 class>」。 */
function describeMutation(r: MutationRecord): string {
  const target = r.target as Partial<Element>;
  const cls = typeof target.className === 'string' ? target.className.split(' ')[0] : '';
  return `mutation:${r.attributeName ?? r.type}:${target.tagName?.toLowerCase() ?? r.target.nodeName}${cls ? `.${cls}` : ''}`;
}

/** 掛上所有翻頁訊號，回傳拆掉的函式。 */
export function watchPageTurns(deps: PageTurnWatchDeps): () => void {
  const { isOwn, relatesToPage, document, window } = deps;
  const signal = createPageTurnSignal(deps);
  const onEvent = (event: Event) => {
    if (event.type === 'keydown' && isModifierKeydown(event)) return;
    if (PAGE_TARGET_EVENTS.has(event.type) && event.target && !relatesToPage(event.target as Node, false)) return;
    signal.fire(event.type);
  };
  // capture：scroll 與 load 不會冒泡，capture 才收得到頁面內任何元素的
  for (const type of EVENTS) document.addEventListener(type, onEvent, { capture: true, passive: true });
  window.addEventListener('resize', onEvent);
  // 看不見的頁面不重繪，SW 不截它（#197）；重新可見時重掃一次，期間換的頁才不會漏掉
  const onVisibility = () => {
    if (document.visibilityState === 'visible') signal.fire('visibilitychange');
  };
  document.addEventListener('visibilitychange', onVisibility);
  const observer = new deps.MutationObserver((records) => {
    const foreign = (r: MutationRecord) =>
      r.type === 'childList'
        ? [...r.addedNodes].some((n) => !isOwn(n) && relatesToPage(n, true)) || [...r.removedNodes].some((n) => !isOwn(n) && relatesToPage(n, false))
        : !isOwn(r.target, r.attributeName ?? undefined) && relatesToPage(r.target, false);
    const first = records.find(foreign);
    if (first) signal.fire(__DEBUG__ ? describeMutation(first) : undefined);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
  return () => {
    signal.cancel();
    observer.disconnect();
    for (const type of EVENTS) document.removeEventListener(type, onEvent, { capture: true });
    window.removeEventListener('resize', onEvent);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
