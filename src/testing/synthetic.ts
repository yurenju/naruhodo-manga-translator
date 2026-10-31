/**
 * 測試用：讀 testdata/synthetic/out 的合成頁與 ground truth（Node）。
 * PNG 只需要支援合成頁用的格式：8-bit RGB／RGBA、非交錯。
 */
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { ERASE_PADDING, expandBox, tupleBox } from '../content/overlay-layout.ts';
import { eraseLuminance } from '../offscreen/erase-color.ts';
import type { GrayImage } from '../shared/page-hash.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { grayOfRgba, type RgbaImage } from '../shared/pixels.ts';

const OUT_DIR = new URL('../../testdata/synthetic/out/', import.meta.url);

/** ground truth 的座標都是 PNG 像素 [x, y, w, h]。 */
export type GtBox = [number, number, number, number];

export interface GtText {
  id: string;
  kind: 'balloon' | 'thought' | 'narration' | 'sfx' | 'sign' | 'outside';
  shape: string;
  page: number | null;
  order: number;
  orientation: 'vertical' | 'horizontal';
  bbox: GtBox;
  textBbox: GtBox;
  ja: string;
  reading: string;
  /** 頁面上印的振り仮名（義訓以這裡為準）。 */
  ruby?: { base: string; rt: string }[];
  zh: string;
}

export interface GtPage {
  id: string;
  width: number;
  height: number;
  pages: { index: number; bbox: GtBox }[];
  texts: GtText[];
}

export const SYNTHETIC_IDS = [
  'p01-basic',
  'p02-ruby',
  'p03-shapes',
  'p04-outside',
  'p05-dense',
  'p06-horizontal',
  'p07-spread',
  'p08-action',
  'p09-erase',
] as const;

export function readGroundTruth(id: string): GtPage {
  return JSON.parse(readFileSync(new URL(`${id}.json`, OUT_DIR), 'utf8')) as GtPage;
}

/** 解出 RGBA；name 是 out/ 裡的檔名（不含 .png），例如 p09-erase-blank。 */
export function readRgba(name: string): RgbaImage {
  const png = readFileSync(new URL(`${name}.png`, OUT_DIR));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || png[28] !== 0) {
    throw new Error(`unsupported PNG ${name}: depth ${bitDepth} color ${colorType}`);
  }
  const channels = colorType === 2 ? 3 : 4;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = (line[i]! + predictor) & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = pixels[i * channels + c]!;
    data[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3]! : 255;
  }
  return { data, width, height };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** RGBA 編成 PNG data URL（offscreen 用 canvas.toDataURL 做同一件事）。 */
export function pngDataUrl({ data, width, height }: RgbaImage): string {
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    let crc = 0xffffffff;
    for (const byte of typed) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    const out = Buffer.alloc(typed.length + 8);
    out.writeUInt32BE(body.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, typed.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** 解出灰階（跟 offscreen 的 canvas 版同一個公式）。 */
export function readGray(id: string): GrayImage {
  const { data, width, height } = readRgba(id);
  return grayOfRgba(data, width, height);
}

/** 從灰階裁出一塊（Spread 切成單頁用）。 */
export function cropGray(
  { gray, width }: { gray: Uint8Array; width: number },
  [x, y, w, h]: GtBox,
): { gray: Uint8Array; width: number; height: number } {
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) out.set(gray.subarray((y + row) * width + x, (y + row) * width + x + w), row * w);
  return { gray: out, width: w, height: h };
}

/**
 * 仿電子書閱讀器的合成圖：整頁等比例縮放（區塊平均）置中塞進 viewport 大小的畫面，周圍填 border（預設純黑）。
 * 回傳合成圖與內容在裡面的位置。
 */
export function letterbox(
  image: { gray: Uint8Array; width: number; height: number },
  viewport: { width: number; height: number },
  border = 0,
): { image: { gray: Uint8Array; width: number; height: number }; content: { x: number; y: number; width: number; height: number } } {
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const cw = Math.round(image.width * scale);
  const ch = Math.round(image.height * scale);
  const ox = Math.floor((viewport.width - cw) / 2);
  const oy = Math.floor((viewport.height - ch) / 2);
  const gray = new Uint8Array(viewport.width * viewport.height).fill(border);
  for (let ty = 0; ty < ch; ty++) {
    const y0 = (ty * image.height) / ch;
    const y1 = ((ty + 1) * image.height) / ch;
    for (let tx = 0; tx < cw; tx++) {
      const x0 = (tx * image.width) / cw;
      const x1 = ((tx + 1) * image.width) / cw;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const w = (Math.min(x + 1, x1) - Math.max(x, x0)) * wy;
          sum += image.gray[y * image.width + x]! * w;
          area += w;
        }
      }
      gray[(oy + ty) * viewport.width + ox + tx] = Math.round(sum / area);
    }
  }
  return { image: { gray, width: viewport.width, height: viewport.height }, content: { x: ox, y: oy, width: cw, height: ch } };
}

/** 當成 Balloon 的種類（其他是 Loose Text，不是 sfx 的也會覆蓋）。 */
const OVERLAY_KINDS = new Set<GtText['kind']>(['balloon', 'thought', 'narration']);

/**
 * 合成頁的 ground truth 換成每個 Page 的 PageText（覆蓋渲染的第 2 層測試用）：sub＝Page 在整張圖裡的比例範圍
 * （Spread 的兩頁共用同一張圖），座標換成相對 Page 的比例，譯文用參考譯文，擦除底色從原圖算。
 */
export function groundTruthPageTexts(id: string): { sub: RatioRect; text: PageText }[] {
  const gt = readGroundTruth(id);
  const image = readGray(id);
  return gt.pages.map((page) => {
    const [px, py, pw, ph] = page.bbox;
    const ratio = ([x, y, w, h]: GtBox): RatioRect => ({ x: (x - px) / pw, y: (y - py) / ph, w: w / pw, h: h / ph });
    const texts = gt.texts.filter((t) => t.page === page.index);
    const common = (t: GtText) => ({
      id: t.id,
      order: t.order,
      orientation: t.orientation,
      原文: t.ja,
      讀音: t.reading,
      讀音來源: 'llm' as const,
      譯文: t.zh,
      unreadable: false,
    });
    return {
      sub: { x: px / gt.width, y: py / gt.height, w: pw / gt.width, h: ph / gt.height },
      text: {
        balloons: texts
          .filter((t) => OVERLAY_KINDS.has(t.kind))
          .map((t) => ({ ...common(t), balloonBbox: ratio(t.bbox), textBbox: ratio(t.textBbox), eraseLuminance: eraseLuminance(image, expandBox(tupleBox(t.textBbox), ERASE_PADDING)) })),
        // sfx 跟 FakeTranslator 一樣看 ground truth 的種類；沒有擦除小圖，底色用最常出現的亮度
        looseText: texts
          .filter((t) => !OVERLAY_KINDS.has(t.kind))
          .map((t) => ({ ...common(t), bbox: ratio(t.bbox), sfx: t.kind === 'sfx', eraseLuminance: eraseLuminance(image, expandBox(tupleBox(t.bbox), ERASE_PADDING)) })),
      },
    };
  });
}
