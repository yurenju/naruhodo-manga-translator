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

/**
 * 高度的門檻：至少 MIN_PAGE_HEIGHT px，或至少可見高度的 MIN_PAGE_HEIGHT_RATIO，滿足一個就算夠高。
 * 網站首頁、結尾推薦區的縮圖（約 120～300 px）一次好幾十張，誤翻會大量花掉額度，兩個門檻都要擋住它們。
 * 只看比例會漏：一頁接一頁往下排的網站在很高的視窗裡同時完整露出兩頁，每頁都不到一半；只看 px 則在矮視窗裡
 * 擋到縮到 400 px 以下的頁。跟 Page 一樣大的廣告頁兩個都擋不到，一話一兩頁可以接受，不為它加規則。
 */
export const MIN_PAGE_HEIGHT = 400;
export const MIN_PAGE_HEIGHT_RATIO = 0.5;

const minPageHeight = (viewport: Size) => Math.max(MIN_PAGE_SIDE, Math.min(MIN_PAGE_HEIGHT, viewport.height * MIN_PAGE_HEIGHT_RATIO));

/** 超出 viewport 這麼多 CSS px 內仍算完整可見（四捨五入、邊框、捲動停在半像素）。 */
export const VIEWPORT_TOLERANCE = 4;

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - VIEWPORT_TOLERANCE &&
  inner.y >= outer.y - VIEWPORT_TOLERANCE &&
  inner.x + inner.width <= outer.x + outer.width + VIEWPORT_TOLERANCE &&
  inner.y + inner.height <= outer.y + outer.height + VIEWPORT_TOLERANCE;

/**
 * 顯示的長寬比跟圖本身的長寬比差超過這麼多（比值減 1），就當成被拉伸的過渡畫面。
 * 量測：仿電子書閱讀器在 1258×1402 合成的圖，side panel 打開、viewport 變 872×1394 後到重新合成前被撐成 872×1394，
 * 差 43%；Spread 被拉窄到寬 ≤ 高，切不開、當成單頁多翻一次。網站把 width／height 屬性寫得跟圖差一點的情況
 * 看不出變形，取 10% 不擋到它們。
 */
export const MAX_STRETCH = 0.1;

/**
 * 被拉伸：intrinsic＝圖本身的像素（img.naturalWidth、canvas.width），只在 object-fit 是 fill（預設，會變形）時給。
 * 視窗大小一變，整個 viewport 一張圖的閱讀器重新產生圖之前，舊圖被 CSS 撐成新的 viewport 大小。
 * 這時截圖會翻到變形的頁（#55 不穩定的原因），等網站換上新圖（load／src 變動會再觸發掃描）才翻。
 * 還沒載入（0）不知道比例，不算。
 */
export function isStretched(rect: Rect, intrinsic: Size): boolean {
  if (intrinsic.width <= 0 || intrinsic.height <= 0 || rect.width <= 0 || rect.height <= 0) return false;
  const shown = rect.width / rect.height;
  const own = intrinsic.width / intrinsic.height;
  return Math.max(shown / own, own / shown) - 1 > MAX_STRETCH;
}

/**
 * clips＝會裁切內容的祖先（overflow 不是 visible）的 rect：翻頁式 viewer 把隔壁頁放在裁切範圍外，
 * getBoundingClientRect 看不出來，要完整落在每一個裡面才算可見。
 */
export function isPageCandidate(rect: Rect, viewport: Size, clips: readonly Rect[] = [], intrinsic?: Size): boolean {
  return pageCandidateRejection(rect, viewport, clips, intrinsic) === undefined;
}

/**
 * 不是 Page 候選的原因（除錯記錄用）：太小、沒完整落在 viewport 內、被裁切祖先擋住、被拉伸變形（見 isStretched）；
 * 是候選時 undefined。
 */
export function pageCandidateRejection(
  rect: Rect,
  viewport: Size,
  clips: readonly Rect[] = [],
  intrinsic?: Size,
): 'small' | 'outsideViewport' | 'clipped' | 'stretched' | undefined {
  if (rect.width < MIN_PAGE_SIDE || rect.height < minPageHeight(viewport)) return 'small';
  if (!contains({ x: 0, y: 0, ...viewport }, rect)) return 'outsideViewport';
  if (!clips.every((clip) => contains(clip, rect))) return 'clipped';
  if (intrinsic && isStretched(rect, intrinsic)) return 'stretched';
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

/** 直式排版的一串（#282）裡，上下兩個元素的間距、x 與寬度各差這麼多 CSS px 以內才算相接、同一欄。 */
export const COLUMN_TOLERANCE = 1.5;

/**
 * 直式排版（#282、ADR 0004）：哪些元素是上下緊貼、同寬、同 x 座標、在同一個上下捲動範圍裡的一串。
 * 只看幾何：真實網站上每個元素各自包在不同的父元素裡，看不出兄弟關係。scroller＝元素所在的捲動範圍
 * （上下可以捲的祖先，或整份文件）；undefined＝不在任何可以上下捲的範圍裡，不算。
 * 回傳跟 items 同順序：同一串的元素拿到同一個編號，不屬於任何一串（包含只有自己一個）是 undefined。
 * 元素之間有間距的（一頁接一頁、中間留白的網站）不算一串，照一般 Page 的規則。
 */
export function verticalColumns(items: readonly { rect: Rect; scroller: unknown }[]): (number | undefined)[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const near = (a: number, b: number) => Math.abs(a - b) <= COLUMN_TOLERANCE;
  for (const [i, { rect: upper, scroller }] of items.entries()) {
    if (scroller === undefined || upper.width < MIN_PAGE_SIDE || upper.height < MIN_PAGE_SIDE) continue;
    for (const [j, { rect: lower, scroller: other }] of items.entries()) {
      if (i === j || other !== scroller || lower.height < MIN_PAGE_SIDE) continue;
      if (near(upper.y + upper.height, lower.y) && near(upper.x, lower.x) && near(upper.width, lower.width)) parent[find(j)] = find(i);
    }
  }
  const sizes = new Map<number, number>();
  for (const i of items.keys()) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
  return items.map((_, i) => (sizes.get(find(i))! > 1 ? find(i) : undefined));
}

/**
 * 直式排版的一串裡的一個元素看得到的那一截（rect ∩ viewport ∩ 裁切祖先）；整個在可見範圍外、或寬度放不下時 undefined。
 * 不像 longPageVisible 要求比可見範圍高、露出夠多：一串是一起辨識的，只露出一點的元素也算在這一串的可見範圍裡。
 */
export function columnMemberVisible(rect: Rect, viewport: Size, clips: readonly Rect[] = []): Rect | undefined {
  const range = visibleRange(viewport, clips);
  if (rect.x < range.x - VIEWPORT_TOLERANCE || rect.x + rect.width > range.x + range.width + VIEWPORT_TOLERANCE) return undefined;
  const top = Math.max(rect.y, range.y);
  const bottom = Math.min(rect.y + rect.height, range.y + range.height);
  if (bottom - top < 1) return undefined;
  return { x: rect.x, y: top, width: rect.width, height: bottom - top };
}

/**
 * 一串裡看得到的元素合起來的範圍（它們上下相接，所以是一整塊），以及這一塊的上下緣是不是被可見範圍切掉的
 * （外面還有這一串的內容）：被切的那一緣上的框先不收，用相鄰兩次截圖拼接後再辨識。
 * members：這一串裡看得到的元素，各自的整個 rect 與看得到的那一截。
 * hidden：這一串裡整個在可見範圍外的元素的 rect：可見範圍剛好停在交界上時，交界另一邊還有內容，那一緣也算被切。
 */
export function columnRegion(
  members: readonly { rect: Rect; visible: Rect }[],
  hidden: readonly Rect[] = [],
): { region: Rect; cutTop: boolean; cutBottom: boolean } {
  const top = Math.min(...members.map((m) => m.visible.y));
  const bottom = Math.max(...members.map((m) => m.visible.y + m.visible.height));
  const first = members.reduce((a, b) => (b.rect.y < a.rect.y ? b : a));
  const last = members.reduce((a, b) => (b.rect.y + b.rect.height > a.rect.y + a.rect.height ? b : a));
  return {
    region: { x: first.rect.x, y: top, width: first.rect.width, height: bottom - top },
    cutTop: first.rect.y < top - VIEWPORT_TOLERANCE || hidden.some((r) => r.y < first.rect.y),
    cutBottom: last.rect.y + last.rect.height > bottom + VIEWPORT_TOLERANCE || hidden.some((r) => r.y > last.rect.y),
  };
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
