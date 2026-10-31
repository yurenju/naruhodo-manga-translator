/**
 * 截圖前後頁面上要做的事（spec #27 第 3.2 節、#59、#60）：讓頁面持續重繪（靜止的頁面截一次要等 1.6 s）、
 * 藏起疊在 Page 上的元素、視情況藏自己的覆蓋層，等瀏覽器重繪完才讓 SW 截；截完立刻還原。
 */
import { createTrace } from '../shared/trace.ts';
import { describeElement, findOccluders, hideOccluders, type HiddenOccluders } from './occlusion.ts';
import { untilRepainted, type Overlay } from './overlay.ts';
import { startRepaint, stopRepaint } from './repaint.ts';

const trace = createTrace('content');

export interface CaptureFinished {
  /** false：藏起來的元素在截圖期間被換掉（selector 選到別的元素），這張截圖不能用。 */
  stable: boolean;
  /** 覆蓋層被藏了多久（ms）；沒藏是 undefined。 */
  overlayHiddenMs: number | undefined;
}

export function createCapturePrep({ overlay, anchors, longAnchors, isOwn }: {
  overlay: Overlay;
  /** 最近一次量到的 Page 候選元素。 */
  anchors: () => Element[];
  /** 其中的長 Page（spec #142）：它們的覆蓋層一律不藏。 */
  longAnchors: ReadonlySet<Element>;
  isOwn: (element: Element) => boolean;
}) {
  let occluders: HiddenOccluders | undefined;

  /** hideOverlay＝false：SW 已經記過帶覆蓋層的樣子，只藏網站的遮擋物。 */
  async function prepare(hideOverlay: boolean): Promise<void> {
    occluders?.restore();
    startRepaint();
    const startedAt = performance.now();
    const found = findOccluders(anchors(), isOwn);
    occluders = hideOccluders(found);
    if (__DEBUG__) trace('capture:prepare', { hideOverlay, ms: performance.now() - startedAt, occluders: found.slice(0, 10).map(describeElement) });
    try {
      await Promise.all([hideOverlay ? overlay.hideForCapture(longAnchors) : undefined, occluders.count > 0 ? untilRepainted() : undefined]);
    } catch (e) {
      // SW 收到失敗就不會叫 finish：自己先還原，網站的元素才不會一直藏著
      finish();
      throw e;
    }
  }

  function finish(): CaptureFinished {
    stopRepaint();
    const stable = occluders?.restore() ?? true;
    occluders = undefined;
    return { stable, overlayHiddenMs: overlay.restoreAfterCapture() };
  }

  return { prepare, finish };
}
