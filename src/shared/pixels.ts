/**
 * 像素換算：RGBA 轉灰階。本機流水線、Page hash、長 Page 的橫條指紋、擦除都用同一個公式（0.299/0.587/0.114），
 * 瀏覽器（canvas）與 Node（單元測試解 PNG）算出來的灰階才會一樣。
 */
import type { GrayImage } from './page-hash.ts';

/** 彩色像素，跟 canvas 的 ImageData 同樣排法。 */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** RGBA 裡從第 i 個位元組開始的那個像素的亮度 0～255（沒有四捨五入）。 */
export function luma(rgba: ArrayLike<number>, i: number): number {
  return 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
}

/** 整張 RGBA 轉灰階（四捨五入）。 */
export function grayOfRgba(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(luma(rgba, i * 4));
  return { gray, width, height };
}
