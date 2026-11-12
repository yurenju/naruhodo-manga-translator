/**
 * Spread 切頁（spec #27 第 3.2 節、ADR 0003）：一個 Page 候選的截圖 → 一或兩個 Page 在裡面的像素範圍。
 *
 * 1. 去黑邊：電子書閱讀器把頁面等比例縮放塞進視窗，周圍是純黑邊，而且黑邊只會出現在一個方向、兩側等寬（#35 實測）。
 *    所以只把「完全均勻的暗色帶」當黑邊，而且兩側都有、寬度相同才切；深色出血頁、夜景的邊緣不會整條均勻，
 *    單側的純黑出血也不對稱，都會留著。白色留白不算黑邊（白底網站的頁面留白不能切掉）。
 * 2. 去掉任何顏色的均勻邊（含白底網站的左右留白；兩側不一樣寬時只去掉兩側共同的那段，範圍的中心不動）之後寬 > 高才當 Spread，
 *    從那個範圍的正中間切；那個範圍的兩半長寬比要像漫畫頁，
 *    不像的話這次不產生 Page（回傳空陣列，等下一次截圖）：通常是畫面上有東西干擾了形狀，當成一頁會把整張 Spread
 *    送去翻譯（#55）。形狀、中縫與長寬比都看同一個範圍，左右留白才不會讓長寬比失準。切出來的兩頁仍延伸到去黑邊後的外緣：
 *    白色留白跟單頁一樣算在頁面裡（第 1 點）。去白邊會連頁面本身對稱的留白一起切掉，送進 OCR 的圖跟 hash 都會變（#55 試過）。
 * 3. 完全均勻的一半（跨頁模式只顯示一頁時的空白半邊）丟掉。
 *
 * 寬 ≤ 高的候選也去黑邊：電子書閱讀器直式視窗的單頁有上下黑邊，不去的話跟跨頁切出來的同一頁 hash 對不上。
 * 已知限制：左右兩頁寬度不同、中縫不在正中間時會切偏。
 */
import type { Rect } from '../shared/messages.ts';
import type { GrayImage } from '../shared/page-hash.ts';

/** 黑邊的亮度上限（0～255）。 */
const BORDER_MAX_LUMINANCE = 48;
/** 一整列（行）最亮與最暗差在這以內才算均勻。 */
const UNIFORM_RANGE = 6;
/** 兩側黑邊寬度可以差幾 px（置中時取整、邊界的反鋸齒）。 */
const BORDER_SYMMETRY_PX = 2;
/** 漫畫單頁的長寬比（寬÷高）範圍；一般約 0.7。 */
const PAGE_ASPECT_MIN = 0.5;
const PAGE_ASPECT_MAX = 0.9;

/** 回傳的 Page 依閱讀順序（Spread 先右後左），座標相對 image；寬 > 高卻切不開時是空陣列。 */
export function splitSpread(image: GrayImage): Rect[] {
  const content = inset(borderWidths(image, isBorderLine), (a, b) => (symmetric(a, b) ? [a, b] : [0, 0]));
  // 是不是 Spread、中縫、長寬比都看去掉任何顏色的均勻邊之後的形狀：白底網站上置中的單頁不能從中間切開。
  // 在去黑邊後的範圍裡找，黑邊不算進形狀（電子書閱讀器實測：連黑邊一起算長寬比，整張截圖的一半不像漫畫頁）。
  // 兩側只裁共同的那段留白（較窄的一側）：閱讀器把跨頁置中，兩頁的圖外緣留白不一樣寬時，中縫仍在畫面正中間，
  // 多出來的那段留白也不會讓長寬比失準（#277：寬視窗整張截圖的一半不像漫畫頁，整張跨頁都不翻）。
  // 不照各側實際的留白裁：只顯示一頁時空白那半也是均勻的，會被當留白裁掉，變成單頁的形狀（第 3 點）
  const shape = inset(borderWidths(image, isUniform, content), (a, b) => [Math.min(a, b), Math.min(a, b)]);
  if (shape.width <= shape.height) return [content];
  const half = Math.round(shape.width / 2);
  const seam = shape.x + half;
  const aspect = (width: number) => width / shape.height;
  if ([half, shape.width - half].some((w) => aspect(w) < PAGE_ASPECT_MIN || aspect(w) > PAGE_ASPECT_MAX)) return [];
  const right: Rect = { x: seam, y: content.y, width: content.x + content.width - seam, height: content.height };
  const left: Rect = { x: content.x, y: content.y, width: seam - content.x, height: content.height };
  const pages = [right, left].filter((r) => !isUniform(image, r));
  return pages.length > 0 ? pages : [content];
}

/** 從灰階圖裁出一塊（Page hash 用）。 */
export function cropImage({ gray, width }: GrayImage, rect: Rect): GrayImage {
  const out = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const start = (rect.y + row) * width + rect.x;
    out.set(gray.subarray(start, start + rect.width), row * rect.width);
  }
  return { gray: out, width: rect.width, height: rect.height };
}

/** 範圍內像素的最暗與最亮。 */
function rangeOf(image: GrayImage, rect: Rect): { min: number; max: number } {
  let min = 255;
  let max = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const v = image.gray[y * image.width + x]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

function isUniform(image: GrayImage, rect: Rect): boolean {
  const { min, max } = rangeOf(image, rect);
  return max - min <= UNIFORM_RANGE;
}

function isBorderLine(image: GrayImage, rect: Rect): boolean {
  const { min, max } = rangeOf(image, rect);
  return max <= BORDER_MAX_LUMINANCE && max - min <= UNIFORM_RANGE;
}

/** 從某一邊往內數有幾條均勻的暗色線。 */
function countBorder(length: number, lineAt: (i: number) => Rect, isBorder: LineTest): number {
  let n = 0;
  while (n < length && isBorder(lineAt(n))) n++;
  return n;
}

/** 兩側都有黑邊、寬度相同才算。 */
const symmetric = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a - b) <= BORDER_SYMMETRY_PX;

type LineTest = (line: Rect) => boolean;

/** within 範圍裡四邊各有幾條符合 lineTest 的線；整塊都符合時四邊都是 0（沒有內容可切）。 */
interface Borders {
  within: Rect;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function borderWidths(
  image: GrayImage,
  lineTest: (image: GrayImage, line: Rect) => boolean,
  within: Rect = { x: 0, y: 0, width: image.width, height: image.height },
): Borders {
  const { x, y, width, height } = within;
  const isBorder: LineTest = (line) => lineTest(image, line);
  const top = countBorder(height, (i) => ({ x, y: y + i, width, height: 1 }), isBorder);
  if (top === height) return { within, top: 0, bottom: 0, left: 0, right: 0 };
  return {
    within,
    top,
    bottom: countBorder(height, (i) => ({ x, y: y + height - 1 - i, width, height: 1 }), isBorder),
    left: countBorder(width, (i) => ({ x: x + i, y, width: 1, height }), isBorder),
    right: countBorder(width, (i) => ({ x: x + width - 1 - i, y, width: 1, height }), isBorder),
  };
}

/** 依 pick（兩側的邊寬 → 兩側實際要裁多少）把範圍往內縮。 */
function inset({ within, top, bottom, left, right }: Borders, pick: (a: number, b: number) => [number, number]): Rect {
  const [t, b] = pick(top, bottom);
  const [l, r] = pick(left, right);
  return { x: within.x + l, y: within.y + t, width: within.width - l - r, height: within.height - t - b };
}
