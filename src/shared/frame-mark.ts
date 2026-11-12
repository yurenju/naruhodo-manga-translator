/**
 * Frame 記號：認出 captureVisibleTab 交回的是不是 prepareCapture 之後的 frame。
 *
 * 兩個 rAF 跑完不保證新內容已經送進畫面：高負載下（headless 實測，真實 Chrome 也看過）截圖偶爾是藏東西之前的
 * 舊 frame，外掛的狀態小標籤、應該藏起來的網站工具列都在裡面（落在黑邊就去不掉黑邊，跨頁被當單頁）。
 * 所以準備截圖時，在 viewport 左上角跟其他要藏的東西「同一個 task」畫上兩個 CSS px 的色塊；截到的 frame
 * 有這個色塊才是準備好之後的。每次截圖兩色對調（mark 0／1），上一次截圖的 frame 也認得出來。
 *
 * 色塊會進截圖：offscreen 解碼後先用旁邊的像素蓋掉（eraseRect），再裁切、算 hash、OCR。
 */
import type { Rect, Size } from './messages.ts';

export type FrameMark = 0 | 1;

/**
 * fresh：記號對。stale：是另一個 mark 的記號（上一次截圖的 frame）。
 * missing：沒有記號，可能是準備之前的 frame，也可能記號被網站的 top layer（全螢幕、dialog）蓋住。
 */
export type FrameVerdict = 'fresh' | 'stale' | 'missing';

export type Rgb = readonly [number, number, number];

const MAGENTA: Rgb = [255, 0, 255];
const GREEN: Rgb = [0, 255, 0];

/** mark → 左、右兩個 CSS px 的顏色。 */
const COLORS: Record<FrameMark, readonly [Rgb, Rgb]> = { 0: [MAGENTA, GREEN], 1: [GREEN, MAGENTA] };

/** 每個 channel 容許的差：截圖的色彩轉換、DPR 非整數時邊緣的混色。 */
const TOLERANCE = 64;

/** 記號在 viewport 的 CSS px 範圍：左上角 2×1。 */
export const FRAME_MARK_SIZE = { width: 2, height: 1 };

const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;

/** content script 畫記號用的背景（左右各一個 CSS px）。 */
export function frameMarkBackground(mark: FrameMark): string {
  const [left, right] = COLORS[mark];
  return `linear-gradient(to right, ${css(left)} 50%, ${css(right)} 50%)`;
}

/** 截圖上的取樣點（兩個 CSS px 的中心）與要蓋掉的範圍（多留一個像素，涵蓋 DPR 非整數時的混色）。 */
export function frameMarkGeometry(viewport: Size, image: Size): { samples: readonly [Point, Point]; eraseRect: Rect } {
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  const y = Math.floor(0.5 * sy);
  return {
    samples: [{ x: Math.floor(0.5 * sx), y }, { x: Math.floor(1.5 * sx), y }],
    eraseRect: { x: 0, y: 0, width: Math.ceil(FRAME_MARK_SIZE.width * sx) + 1, height: Math.ceil(FRAME_MARK_SIZE.height * sy) + 1 },
  };
}

export interface Point {
  x: number;
  y: number;
}

/** 兩個取樣點的 RGB → 這個 frame 是不是 mark 那次準備之後的。 */
export function judgeFrame(left: Rgb, right: Rgb, mark: FrameMark): FrameVerdict {
  const near = (a: Rgb, b: Rgb) => a.every((v, i) => Math.abs(v - b[i]!) <= TOLERANCE);
  const is = (m: FrameMark) => near(left, COLORS[m][0]) && near(right, COLORS[m][1]);
  if (is(mark)) return 'fresh';
  if (is(mark === 0 ? 1 : 0)) return 'stale';
  return 'missing';
}
