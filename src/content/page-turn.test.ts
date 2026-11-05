import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageTurnSignal, PAGE_TURN_DEBOUNCE_MS, watchPageTurns, type PageTurnWatchDeps } from './page-turn.ts';

describe('翻頁訊號', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('連續的事件（翻頁動畫、捲動）停下 debounce 時間後只通知一次', () => {
    const notify = vi.fn();
    const signal = createPageTurnSignal({ notify });

    signal.fire();
    vi.advanceTimersByTime(200);
    signal.fire();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS - 1);
    expect(notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('debounce 在 300–500 ms 之間（spec 第 3.2 節）', () => {
    expect(PAGE_TURN_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
    expect(PAGE_TURN_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });

  it('停止後不再通知', () => {
    const notify = vi.fn();
    const signal = createPageTurnSignal({ notify });

    signal.fire();
    signal.cancel();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);
    signal.fire();
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);

    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * 假的 DOM 節點：isOwn 用 own 判斷是不是覆蓋層自己的；page＝跟 Page 有關（包住或就是 Page 候選），
 * newPage＝新加入時算跟 Page 有關（例如包著新的 canvas）。
 */
type FakeNode = { own: boolean; page?: boolean; newPage?: boolean };
const node = (own: boolean, related: Partial<Pick<FakeNode, 'page' | 'newPage'>> = { page: true }) =>
  ({ own, ...related }) as FakeNode as unknown as Node;
/** 跟 Page 無關的頁面元素（例如網站自己的頂部選單）。 */
const unrelated = () => node(false, {});

/** 目標是某個元素的事件（dispatch 到 document，模擬 capture 收到的冒泡事件）。 */
function eventOn(type: string, target: Node, props: Record<string, unknown> = {}): Event {
  const event = Object.assign(new Event(type), props);
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function setup() {
  const notify = vi.fn();
  // document 包住所有 Page：目標是 document 的事件（scroll、load）都算
  const document = Object.assign(new EventTarget(), { documentElement: node(false), own: false, page: true, visibilityState: 'visible' as DocumentVisibilityState });
  const window = new EventTarget();
  let onMutation: MutationCallback | undefined;
  const disconnect = vi.fn();
  class FakeObserver {
    constructor(callback: MutationCallback) {
      onMutation = callback;
    }
    observe() {}
    disconnect = disconnect;
  }
  const deps: PageTurnWatchDeps = {
    notify,
    isOwn: (n, attribute) => (n as unknown as FakeNode).own || attribute === 'data-own',
    relatesToPage: (n, added) => {
      const f = n as unknown as FakeNode;
      return f.page === true || (added && f.newPage === true);
    },
    document,
    window,
    MutationObserver: FakeObserver,
  };
  const stop = watchPageTurns(deps);
  const mutate = (records: Partial<MutationRecord>[]) => onMutation!(records as MutationRecord[], {} as MutationObserver);
  const childList = (...nodes: Node[]): Partial<MutationRecord> => ({ type: 'childList', addedNodes: nodes as unknown as NodeList, removedNodes: [] as unknown as NodeList });
  return { notify, document, window, stop, mutate, childList, disconnect };
}

describe('watchPageTurns', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('頁面的捲動、按鍵、img load、resize 都會在 debounce 後通知', () => {
    for (const fire of [
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(new Event('scroll')),
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(new Event('keydown')),
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(new Event('load')),
      (t: ReturnType<typeof setup>) => t.window.dispatchEvent(new Event('resize')),
    ]) {
      const t = setup();
      fire(t);
      vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
      expect(t.notify).toHaveBeenCalledTimes(1);
      t.stop();
    }
  });

  it('頁面重新可見時通知（#197：看不見時頁面不重繪、不截圖，回來要重掃）；變成看不見不算', () => {
    const t = setup();

    t.document.visibilityState = 'hidden';
    t.document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).not.toHaveBeenCalled();

    t.document.visibilityState = 'visible';
    t.document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('頁面自己的 DOM 變動會通知；只有覆蓋層自己的變動不算翻頁', () => {
    const t = setup();

    t.mutate([t.childList(node(true)), { type: 'attributes', target: node(false), attributeName: 'data-own' }]);
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).not.toHaveBeenCalled();

    t.mutate([t.childList(node(true), node(false))]);
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  // 以下來自真實的 canvas 網站（#27 除錯）：這些訊號觸發的截圖 hash 都沒變，卻讓譯文消失 0.3–2.5 秒
  it('只按修飾鍵（alt-tab 的 Alt）或按住 Alt／Ctrl／Meta 的組合鍵不算翻頁', () => {
    const t = setup();
    for (const props of [{ key: 'Alt' }, { key: 'Control' }, { key: 'Shift' }, { key: 'Meta' }, { key: 'Tab', altKey: true }, { key: 'c', ctrlKey: true }]) {
      t.document.dispatchEvent(eventOn('keydown', t.document as unknown as Node, props));
    }
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).not.toHaveBeenCalled();

    for (const key of ['ArrowLeft', ' ', 'PageDown']) {
      t.document.dispatchEvent(eventOn('keydown', t.document as unknown as Node, { key }));
      vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    }
    t.document.dispatchEvent(eventOn('keydown', t.document as unknown as Node, { key: ' ', shiftKey: true }));
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).toHaveBeenCalledTimes(4);
  });

  it('跟 Page 無關的元素改 class／style、播動畫、載入圖片不算翻頁（canvas 網站的頂部選單自己收合）', () => {
    const t = setup();
    const header = unrelated();
    t.mutate([
      { type: 'attributes', target: header, attributeName: 'class' },
      { type: 'attributes', target: header, attributeName: 'style' },
      t.childList(unrelated()),
    ]);
    for (const type of ['transitionend', 'animationend', 'load']) t.document.dispatchEvent(eventOn(type, header));
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('包住 Page 的容器改 style、Page 換 src、加入新的 Page 元素、Page 的動畫結束都算翻頁', () => {
    for (const fire of [
      (t: ReturnType<typeof setup>) => t.mutate([{ type: 'attributes', target: node(false), attributeName: 'style' }]),
      (t: ReturnType<typeof setup>) => t.mutate([{ type: 'attributes', target: node(false), attributeName: 'src' }]),
      (t: ReturnType<typeof setup>) => t.mutate([t.childList(node(false, { newPage: true }))]),
      (t: ReturnType<typeof setup>) => t.document.dispatchEvent(eventOn('transitionend', node(false))),
    ]) {
      const t = setup();
      fire(t);
      vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS);
      expect(t.notify).toHaveBeenCalledTimes(1);
      t.stop();
    }
  });

  it('拆掉之後事件不再通知，MutationObserver 也斷開', () => {
    const t = setup();

    t.stop();
    t.document.dispatchEvent(new Event('scroll'));
    t.window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(PAGE_TURN_DEBOUNCE_MS * 2);

    expect(t.notify).not.toHaveBeenCalled();
    expect(t.disconnect).toHaveBeenCalled();
  });
});
