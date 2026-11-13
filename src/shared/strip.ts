/**
 * Strip（條漫，#282、GLOSSARY）：直式排版的一串元素裡，內容連續、只是被網站切成固定高度的那一種。這裡是純函式：
 * - 交界上下兩列像素接不接得起來（真的頁還是切片）。
 * - 相鄰兩次截圖怎麼拼（被可見範圍邊緣切到的框）。
 * - Strip 的計費：每幾句 Line 計一個 Translated Page。
 */
import { STRIP_LINES_PER_PAGE } from './hosted-api.ts';
import type { JunctionVerdict } from './messages.ts';

/**
 * 交界上下兩列的亮度（0～255）平均差這麼多以內、相關係數至少這麼高，才算接得起來。
 * 量測（#282，電子書閱讀器的直式捲動，12 個交界）：兩邊有內容的 5 個平均差 1～10，剛好切在格子邊界的 2 個約 100。
 * 只看平均差會被稀疏的線條騙：兩列各只有幾 % 的黑點、位置完全不同時平均差也很小，所以再要求相關係數（位置要對得上）。
 */
export const JUNCTION_MAX_DIFF = 16;
export const JUNCTION_MIN_CORRELATION = 0.8;

/** 一列的亮度標準差至少這麼多才算有內容；兩列都沒有內容（留白、純色底）看不出接不接得起來。 */
export const JUNCTION_MIN_CONTRAST = 10;

export interface JunctionMeasure {
  verdict: JunctionVerdict;
  /** 兩列的平均亮度差。 */
  diff: number;
  /** 兩列裡比較小的那個標準差。 */
  contrast: number;
  /** 兩列的相關係數；有一列沒有內容時是 0。 */
  correlation: number;
}

/**
 * 交界上面那一列與下面那一列（同樣長度的灰階）：continuous＝接得起來而且有內容（同一張圖被切開）；
 * blank＝差很小但沒有內容，看不出來；break＝接不起來（各自是一張圖）。
 */
export function junctionVerdict(above: ArrayLike<number>, below: ArrayLike<number>): JunctionMeasure {
  const n = Math.min(above.length, below.length);
  if (n === 0) return { verdict: 'blank', diff: 0, contrast: 0, correlation: 0 };
  let sumA = 0;
  let sumB = 0;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    sumA += above[i]!;
    sumB += below[i]!;
    diff += Math.abs(above[i]! - below[i]!);
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const a = above[i]! - meanA;
    const b = below[i]! - meanB;
    varA += a * a;
    varB += b * b;
    cov += a * b;
  }
  const contrast = Math.sqrt(Math.min(varA, varB) / n);
  const correlation = varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
  const measure = { diff: diff / n, contrast, correlation };
  if (measure.diff > JUNCTION_MAX_DIFF) return { verdict: 'break', ...measure };
  if (contrast < JUNCTION_MIN_CONTRAST) return { verdict: 'blank', ...measure };
  return { verdict: correlation >= JUNCTION_MIN_CORRELATION ? 'continuous' : 'break', ...measure };
}

/** 一段列（截圖像素），上緣含、下緣不含。 */
export interface Rows {
  top: number;
  bottom: number;
}

/** 拼接的視窗在被切的框外面多留這麼多截圖像素。 */
const STITCH_PADDING = 32;

/** 兩次截圖的範圍差不到這麼多列就當成接得上（換算時的四捨五入）。 */
const STITCH_GAP = 2;

export interface StitchWindow {
  /** 拼起來要辨識的範圍（這次截圖的座標；超出這次範圍的部分取自上一次的截圖）。 */
  window: Rows;
  /** 兩張截圖接起來的那一列：這次範圍被切的那一緣。跨過它的框才是這次要補收的。 */
  seam: number;
  /** 這次範圍的哪一緣接上一次的截圖。 */
  edge: 'top' | 'bottom';
}

/**
 * 相鄰兩次截圖怎麼拼（#282）：這次有框被可見範圍的上緣切到、而上一次的範圍接在上面（讀者往下捲了不到一個畫面），
 * 就把上一次的範圍接在這次上面；被下緣切到、上一次接在下面（往上捲）也一樣。兩次的範圍沒有接上（一次捲超過一個畫面）
 * 或被切的那一緣不是接上一次的那一緣時 undefined，那些框等之後完整出現或接得上時再收。
 * current：這次整串看得到的範圍；previous：上一次的範圍換到這次截圖的座標；
 * cutTop／cutBottom：這次被上緣／下緣切到的框。
 */
export function stitchWindow(current: Rows, previous: Rows, cutTop: readonly Rows[], cutBottom: readonly Rows[]): StitchWindow | undefined {
  if (cutTop.length > 0 && previous.top < current.top - STITCH_GAP && previous.bottom >= current.top - STITCH_GAP) {
    const lowest = Math.max(...cutTop.map((b) => b.bottom));
    return { window: { top: previous.top, bottom: Math.min(current.bottom, lowest + STITCH_PADDING) }, seam: current.top, edge: 'top' };
  }
  if (cutBottom.length > 0 && previous.bottom > current.bottom + STITCH_GAP && previous.top <= current.bottom + STITCH_GAP) {
    const highest = Math.min(...cutBottom.map((b) => b.top));
    return { window: { top: Math.max(current.top, highest - STITCH_PADDING), bottom: previous.bottom }, seam: current.bottom, edge: 'bottom' };
  }
  return undefined;
}

/** Strip 翻了這麼多句 Line 一共計幾個 Translated Page：無條件進位，第 1 句就計第 1 頁。 */
export function stripPages(lines: number): number {
  return Math.ceil(lines / STRIP_LINES_PER_PAGE);
}

/** Strip 已經翻了 before 句、這次再翻 added 句，這次要多計幾個 Translated Page。 */
export function stripPagesAdded(before: number, added: number): number {
  return stripPages(before + added) - stripPages(before);
}
