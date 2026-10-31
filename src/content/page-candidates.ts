/**
 * Page 候選的判斷（ADR 0003、spec #27 第 3.2 節）。只看 getBoundingClientRect()，不碰 DOM，方便單元測試。
 */
import type { Rect, Size } from '../shared/messages.ts';

/**
 * 「夠大」的門檻：寬高都至少這麼多 CSS px。
 * 量測：仿 canvas 網站在 1280×720 的視窗裡每頁顯示成 430×625（合成頁 880×1280 的 0.49×）；
 * 電子書閱讀器是整個 viewport 一張圖。網站上的圖示、頭像、縮圖列通常在 150 px 以下。
 * 取 200 讓窄視窗（canvas 網站約 300 px 寬）仍然認得到，又能排掉小圖。
 */
export const MIN_PAGE_SIDE = 200;

/** 超出 viewport 這麼多 CSS px 內仍算完整可見（四捨五入、邊框、捲動停在半像素）。 */
export const VIEWPORT_TOLERANCE = 4;

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - VIEWPORT_TOLERANCE &&
  inner.y >= outer.y - VIEWPORT_TOLERANCE &&
  inner.x + inner.width <= outer.x + outer.width + VIEWPORT_TOLERANCE &&
  inner.y + inner.height <= outer.y + outer.height + VIEWPORT_TOLERANCE;

/**
 * clips＝會裁切內容的祖先（overflow 不是 visible）的 rect：翻頁式 viewer 把隔壁頁放在裁切範圍外，
 * getBoundingClientRect 看不出來，要完整落在每一個裡面才算可見。
 */
export function isPageCandidate(rect: Rect, viewport: Size, clips: readonly Rect[] = []): boolean {
  return pageCandidateRejection(rect, viewport, clips) === undefined;
}

/** 不是 Page 候選的原因（除錯記錄用）：太小、沒完整落在 viewport 內、被裁切祖先擋住；是候選時 undefined。 */
export function pageCandidateRejection(rect: Rect, viewport: Size, clips: readonly Rect[] = []): 'small' | 'outsideViewport' | 'clipped' | undefined {
  if (rect.width < MIN_PAGE_SIDE || rect.height < MIN_PAGE_SIDE) return 'small';
  if (!contains({ x: 0, y: 0, ...viewport }, rect)) return 'outsideViewport';
  if (!clips.every((clip) => contains(clip, rect))) return 'clipped';
  return undefined;
}

/** 可見範圍：viewport 與每個裁切祖先的交集。 */
function visibleRange(viewport: Size, clips: readonly Rect[]): Rect {
  let left = 0;
  let top = 0;
  let right = viewport.width;
  let bottom = viewport.height;
  for (const clip of clips) {
    left = Math.max(left, clip.x);
    top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * 直式捲動的長 Page（ADR 0004、spec #142）：比可見範圍高、寬度完整放得下的 img／canvas，回傳看得到的那一截
 * （anchor rect ∩ viewport ∩ 裁切祖先）；不是長 Page 時 undefined，照「完整可見」的規則判斷。
 * 看得到的那一截比 MIN_PAGE_SIDE 矮（剛捲進來或快捲走）也不算：放不下一個完整的 Balloon，也沒有完整的橫條認身分。
 * 刻意整個不當候選（一般 Page 的規則要完整可見，也不會收它）：捲到露出夠高、下次捲動停下就會處理。
 */
export function longPageVisible(rect: Rect, viewport: Size, clips: readonly Rect[] = []): Rect | undefined {
  if (rect.width < MIN_PAGE_SIDE) return undefined;
  const range = visibleRange(viewport, clips);
  if (rect.height <= range.height + VIEWPORT_TOLERANCE) return undefined;
  if (rect.x < range.x - VIEWPORT_TOLERANCE || rect.x + rect.width > range.x + range.width + VIEWPORT_TOLERANCE) return undefined;
  const top = Math.max(rect.y, range.y);
  const bottom = Math.min(rect.y + rect.height, range.y + range.height);
  if (bottom - top < MIN_PAGE_SIDE) return undefined;
  return { x: rect.x, y: top, width: rect.width, height: bottom - top };
}
