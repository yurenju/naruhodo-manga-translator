/** 瀏覽器版的 PageImage：用 OffscreenCanvas 縮放、裁切、轉灰階（跟 #7 的 browser.html 一致）。 */
import { grayOfRgba, type RgbaImage } from '../shared/pixels.ts';
import type { PixelBox } from './pipeline/boxes.ts';
import type { PageImage } from './pipeline/analyze.ts';

/** Page 的全解析度 RGBA（擦除小圖用；畫法跟 createPageImage 一樣，空白處當白底）。 */
export function pageRgba(source: ImageBitmap, rect: { x: number; y: number; width: number; height: number }): RgbaImage {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, rect.x, rect.y, width, height, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}


/**
 * source 是整張截圖（或原圖）；rect 是 Page 在 source 裡的範圍（像素）。
 * Page 的像素尺寸＝rect 的尺寸，所有座標都相對這一頁。
 */
export function createPageImage(source: ImageBitmap, rect: { x: number; y: number; width: number; height: number }): PageImage {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const draw = (sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray => {
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dw, dh);
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(source, rect.x + sx, rect.y + sy, sw, sh, 0, 0, dw, dh);
    return ctx.getImageData(0, 0, dw, dh).data;
  };
  return {
    width,
    height,
    rgb640() {
      const data = draw(0, 0, width, height, 640, 640);
      const rgb = new Uint8Array(640 * 640 * 3);
      for (let i = 0; i < 640 * 640; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = data[i * 4 + c]!;
      return rgb;
    },
    gray: () => grayOfRgba(draw(0, 0, width, height, width, height), width, height),
    crop224: ([x, y, w, h]: PixelBox) => grayOfRgba(draw(x, y, w, h, 224, 224), 224, 224).gray,
  };
}
