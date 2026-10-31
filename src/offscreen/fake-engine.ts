/**
 * browser test 用的假 Engine（ADR 0007）：不跑模型，重播真模型在合成頁上錄下來的結果（testdata/synthetic/recorded-ocr.json，
 * `npm run record:ocr` 產生）。重播的是真模型的框與讀到的字，不是 ground truth：框比文字大一圈、旁白框有時被當成框外文字，
 * 這些行為跟 e2e 一致。
 *
 * 送進來的 Page 通常已經去黑邊、Spread 也切成兩頁（spread.ts），就是錄製時的某個範圍縮放後的樣子；
 * 白底的仿電子書閱讀器不去邊，合成頁是等比例縮放、置中在留白裡。縮成小灰階圖跟每個範圍比，挑最像的；
 * 差太多就 throw，不默默回傳錯的答案。分組、閱讀順序、座標換算仍走真的 analyzePage。
 */
import type { RatioRect } from '../shared/page-text.ts';
import type { OrtEngine } from './ort-engine.ts';
import { createPageImage } from './page-image.ts';
import type { Detection, PageImage } from './pipeline/analyze.ts';
import { area, intersection, type PixelBox } from './pipeline/boxes.ts';
import type { GrayImage } from './pipeline/reading-order.ts';

/** 真模型在一個範圍（整張合成圖，或 Spread 的一頁）上的結果；框是相對這個範圍的比例。 */
export interface RecordedOcr {
  /** 合成頁 id（testdata/synthetic/out/<id>.png）。 */
  id: string;
  /** 合成圖裡的範圍 [x, y, w, h]（像素）。 */
  rect: PixelBox;
  /** ocrConfidence：真模型讀到的非標點字最低信心（ADR 0009）。 */
  balloons: { balloonBbox: RatioRect; textBbox: RatioRect; 原文: string; ocrConfidence?: number }[];
  looseText: { bbox: RatioRect; 原文: string; ocrConfidence?: number }[];
}

const THUMB = 32;
/** 縮圖每個像素平均差多少（0～255）以內才算同一頁。已翻譯的頁（覆蓋層蓋著 Balloon）也要認得出來。 */
const MAX_DIFF = 40;
/** 長寬比差在這個比例（log 尺度）以內，就當成 Page 剛好是這個範圍。 */
const MAX_ASPECT_DIFF = 0.1;

/** 灰階圖裡 rect 範圍平均成 32×32（用積分圖，每格 O(1)）；錄製的範圍與送進來的 Page 用同一個函式。 */
function thumbnail({ gray, width, height }: GrayImage, [x, y, w, h]: PixelBox): Float64Array {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  for (let py = 0; py < height; py++) {
    let row = 0;
    for (let px = 0; px < width; px++) {
      row += gray[py * width + px]!;
      sum[(py + 1) * stride + px + 1] = sum[py * stride + px + 1]! + row;
    }
  }
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  const at = (px: number, py: number) => sum[clamp(py, height) * stride + clamp(px, width)]!;
  const thumb = new Float64Array(THUMB * THUMB);
  for (let ty = 0; ty < THUMB; ty++) {
    for (let tx = 0; tx < THUMB; tx++) {
      const x1 = x + (tx * w) / THUMB;
      const x2 = x + ((tx + 1) * w) / THUMB;
      const y1 = y + (ty * h) / THUMB;
      const y2 = y + ((ty + 1) * h) / THUMB;
      const cells = Math.max(1, (clamp(x2, width) - clamp(x1, width)) * (clamp(y2, height) - clamp(y1, height)));
      thumb[ty * THUMB + tx] = (at(x2, y2) - at(x1, y2) - at(x2, y1) + at(x1, y1)) / cells;
    }
  }
  return thumb;
}

const meanDiff = (a: Float64Array, b: Float64Array) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length;

/** 範圍在 Page 裡的位置：長寬比相近就是拉滿整張（已去邊），否則是等比例縮放置中（留白沒去掉）。 */
function placement({ width, height }: { width: number; height: number }, [, , rw, rh]: PixelBox): PixelBox {
  if (Math.abs(Math.log(rw / rh) - Math.log(width / height)) <= MAX_ASPECT_DIFF) return [0, 0, width, height];
  const scale = Math.min(width / rw, height / rh);
  return [(width - rw * scale) / 2, (height - rh * scale) / 2, rw * scale, rh * scale];
}

/**
 * 認頁：給一張 Page 的灰階圖，回傳它是哪個錄製的範圍、擺在 Page 的哪裡。
 * imageOf：合成圖裡某個範圍的灰階圖（瀏覽器用 OffscreenCanvas，unit test 用 Node 解 PNG）。
 */
export function createPageMatcher(recorded: readonly RecordedOcr[], imageOf: (id: string, rect: PixelBox) => GrayImage) {
  const thumbs = recorded.map((r) => {
    const gray = imageOf(r.id, r.rect);
    return thumbnail(gray, [0, 0, gray.width, gray.height]);
  });
  return (gray: GrayImage): { recorded: RecordedOcr; at: PixelBox } => {
    let best: { recorded: RecordedOcr; at: PixelBox; diff: number } | undefined;
    recorded.forEach((r, i) => {
      const at = placement(gray, r.rect);
      const diff = meanDiff(thumbnail(gray, at), thumbs[i]!);
      if (!best || diff < best.diff) best = { recorded: r, at, diff };
    });
    if (!best || best.diff > MAX_DIFF) {
      const closest = best ? `最接近 ${best.recorded.id}（差 ${best.diff.toFixed(1)}）` : '沒有錄製的範圍';
      throw new Error(`FakeEngine 認不出這是哪張合成頁：${closest}`);
    }
    return best;
  };
}

/**
 * recorded：錄製的結果；imageUrl：合成圖的網址（e2e build 放在 synthetic/）；
 * delayMs：每頁故意花的時間（測佇列排程時模擬 OCR 很慢）。
 */
export async function createFakeEngine(recorded: readonly RecordedOcr[], imageUrl: (id: string) => string, delayMs = 0): Promise<OrtEngine> {
  const bitmaps = new Map<string, ImageBitmap>();
  for (const id of new Set(recorded.map((r) => r.id))) bitmaps.set(id, await createImageBitmap(await (await fetch(imageUrl(id))).blob()));
  const match = createPageMatcher(recorded, (id, [x, y, width, height]) => createPageImage(bitmaps.get(id)!, { x, y, width, height }).gray());
  for (const bitmap of bitmaps.values()) bitmap.close();
  return engineFrom(match, delayMs);
}

/** 認頁之後的部分：錄製的框換回 Page 像素當成偵測結果，recognize 用框對回錄到的字（unit test 直接用 Node 版的 matcher）。 */
export function engineFrom(match: ReturnType<typeof createPageMatcher>, delayMs = 0): OrtEngine {
  /** detect 認出的頁上每段文字（Page 像素），給接下來的 recognize 對回原文。 */
  const recognized = new WeakMap<PageImage, { textBbox: PixelBox; 原文: string; ocrConfidence?: number }[]>();

  return {
    executionProvider: 'wasm',
    threads: 1,
    async release() {},
    async detect(image) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const {
        recorded: { balloons, looseText },
        at: [ax, ay, aw, ah],
      } = match(image.gray());
      const toPage = ({ x, y, w, h }: RatioRect): PixelBox => [ax + x * aw, ay + y * ah, w * aw, h * ah];
      const same = (a: RatioRect, b: RatioRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
      recognized.set(image, [
        ...balloons.map((b) => ({ textBbox: toPage(b.textBbox), 原文: b.原文, ocrConfidence: b.ocrConfidence })),
        ...looseText.map((l) => ({ textBbox: toPage(l.bbox), 原文: l.原文, ocrConfidence: l.ocrConfidence })),
      ]);
      return [
        // 沒有外框的 Balloon（偵測到 text_bubble、沒有 bubble）錄下來時 balloonBbox 等於 textBbox
        ...balloons.flatMap((b): Detection[] => [
          ...(same(b.balloonBbox, b.textBbox) ? [] : [{ label: 'bubble' as const, score: 1, box: toPage(b.balloonBbox) }]),
          { label: 'text_bubble', score: 1, box: toPage(b.textBbox) },
        ]),
        ...looseText.map((l): Detection => ({ label: 'text_free', score: 1, box: toPage(l.bbox) })),
      ];
    },
    async recognize(image, boxes) {
      const texts = recognized.get(image) ?? [];
      // 只錄了每段的最低信心，所以每個字都給這個值：analyzePage 算出來的最低信心就等於錄下來的
      return boxes.map((box) => {
        let best: { 原文: string; ocrConfidence?: number; cover: number } = { 原文: '', cover: 0 };
        for (const t of texts) {
          const cover = intersection(box, t.textBbox) / area(t.textBbox);
          if (cover > best.cover) best = { ...t, cover };
        }
        return { text: best.原文, confidences: [...best.原文].map(() => best.ocrConfidence ?? 1) };
      });
    },
  };
}
