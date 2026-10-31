/**
 * 本機流水線的一個 Page（spec #27 第 3.3 節）：偵測 → 分組成 Balloon／Loose Text → 閱讀順序 → OCR → 讀音後備。
 * 移植自 prototype/local-ocr-pipeline 的 core.mjs（#7）。模型呼叫（onnxruntime-web）在 Engine 後面，這裡只有純邏輯。
 */
import type { BalloonText, LooseText, Orientation, PageText, RatioRect } from '../../shared/page-text.ts';
import { area, intersection, union, type PixelBox } from './boxes.ts';
import { readingOrder, type GrayImage } from './reading-order.ts';

export const DETECTION_LABELS = ['bubble', 'text_bubble', 'text_free'] as const;

export interface Detection {
  label: (typeof DETECTION_LABELS)[number];
  score: number;
  /** Page 原始像素。 */
  box: PixelBox;
}

/** 影像存取；瀏覽器版用 OffscreenCanvas（offscreen/page-image.ts）。 */
export interface PageImage {
  width: number;
  height: number;
  /** 整頁拉伸（不保比例）到 640×640 的 RGB（HWC）。 */
  rgb640(): Uint8Array;
  gray(): GrayImage;
  /** 裁出一塊並拉伸成 224×224 灰階。 */
  crop224(box: PixelBox): Uint8Array;
}

/** OCR 讀到的一段。 */
export interface Recognized {
  text: string;
  /** text 每個字（code point）的信心：解碼那一步 softmax 的最高機率。 */
  confidences: number[];
}

export interface Engine {
  /** detector 的原始輸出（還沒套門檻與 NMS），座標已是原圖像素。 */
  detect(image: PageImage): Promise<Detection[]>;
  /** 每個框各 OCR 一次，回傳同樣順序的結果。 */
  recognize(image: PageImage, boxes: PixelBox[]): Promise<Recognized[]>;
}

/** 偵測分數門檻（#7）。 */
const SCORE_THRESHOLD = 0.4;
/** 同類別的兩個框交集 / 較小面積超過這個值，只留分數高的。 */
const NMS_OVERLAP = 0.7;
/** 文字框至少有這個比例落在 Balloon 裡才歸給它。 */
const IN_BALLOON = 0.5;

function nms(detections: Detection[]): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    const duplicate = keep.some(
      (k) => k.label === d.label && intersection(k.box, d.box) / Math.min(area(k.box), area(d.box)) > NMS_OVERLAP,
    );
    if (!duplicate) keep.push(d);
  }
  return keep;
}

interface Unit {
  kind: 'balloon' | 'loose';
  /** Balloon 外框；沒有外框的 Balloon 與 Loose Text 等於 textBbox。 */
  bbox: PixelBox;
  textBbox: PixelBox;
}

/** 文字框歸到交集最大的 Balloon；沒有文字的 Balloon 丟掉（合成頁的圓臉常被當成 Balloon）。 */
function group(detections: Detection[]): Unit[] {
  const bubbles = detections.filter((d) => d.label === 'bubble').map((d) => ({ box: d.box, texts: [] as PixelBox[] }));
  const free: Detection[] = [];
  for (const t of detections.filter((d) => d.label !== 'bubble')) {
    let best: (typeof bubbles)[number] | undefined;
    let bestCover = 0;
    for (const b of bubbles) {
      const cover = intersection(t.box, b.box) / area(t.box);
      if (cover > bestCover) {
        best = b;
        bestCover = cover;
      }
    }
    if (best && bestCover >= IN_BALLOON) best.texts.push(t.box);
    else free.push(t);
  }
  return [
    ...bubbles.filter((b) => b.texts.length).map((b): Unit => ({ kind: 'balloon', bbox: b.box, textBbox: union(b.texts) })),
    ...free.map((t): Unit => ({ kind: t.label === 'text_bubble' ? 'balloon' : 'loose', bbox: t.box, textBbox: t.box })),
  ];
}

/** OCR 的裁切範圍：文字框往外擴（短邊 8%＋2 px），夾在 Page 內。 */
function ocrBox([x, y, w, h]: PixelBox, width: number, height: number): PixelBox {
  const pad = Math.round(Math.min(w, h) * 0.08) + 2;
  const left = Math.max(0, x - pad);
  const top = Math.max(0, y - pad);
  return [left, top, Math.min(width - left, w + 2 * pad), Math.min(height - top, h + 2 * pad)];
}

/** 只有標點（例如臉被當成 Balloon 而 OCR 出「…」）的不算文字。 */
const hasText = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** 非標點字的最低信心低於這個值，整段當成 unreadable、不覆蓋（ADR 0009，數字來自 #140）。 */
const OCR_CONFIDENCE_THRESHOLD = 0.25;

/** 算最低信心時不看的字：標點、符號、空白、長音（ー 在 Unicode 算字母）。 */
const NOT_COUNTED = /[\p{P}\p{S}\p{Z}ーｰ]/u;

/** 非標點字的最低信心；沒有非標點字時 undefined。 */
function minConfidence({ text, confidences }: Recognized): number | undefined {
  const counted = [...text].flatMap((char, i) => (NOT_COUNTED.test(char) ? [] : [confidences[i] ?? 1]));
  return counted.length ? Math.min(...counted) : undefined;
}

/**
 * accept：收不收一個框（外框，0～1 比例）；不收的不做 OCR、不出現在結果。長 Page 用它擋掉被可見範圍切到的框
 * 與已收過的框（spec #142）；閱讀順序仍然看整頁的框排。
 */
export async function analyzePage(engine: Engine, image: PageImage, reading: (ja: string) => string, accept?: (box: RatioRect) => boolean): Promise<PageText> {
  const { width, height } = image;
  const ratio = ([x, y, w, h]: PixelBox): RatioRect => ({ x: x / width, y: y / height, w: w / width, h: h / height });
  const detections = nms((await engine.detect(image)).filter((d) => d.score >= SCORE_THRESHOLD));
  const units = readingOrder(group(detections), image.gray()).filter((u) => accept?.(ratio(u.bbox)) ?? true);
  const recognized = await engine.recognize(
    image,
    units.map((u) => ocrBox(u.textBbox, width, height)),
  );
  const orientation = (b: PixelBox): Orientation => (b[3] >= b[2] ? 'vertical' : 'horizontal');

  const result: PageText = { balloons: [], looseText: [] };
  let order = 0;
  units.forEach((unit, i) => {
    const ocr = recognized[i] ?? { text: '', confidences: [] };
    const 原文 = ocr.text;
    if (!hasText(原文)) return;
    order++;
    const ocrConfidence = minConfidence(ocr);
    const common = {
      order,
      orientation: orientation(unit.textBbox),
      原文,
      讀音: reading(原文),
      讀音來源: 'kuromoji',
      譯文: '',
      unreadable: ocrConfidence !== undefined && ocrConfidence < OCR_CONFIDENCE_THRESHOLD,
      ...(ocrConfidence === undefined ? {} : { ocrConfidence }),
    } as const;
    if (unit.kind === 'balloon') {
      result.balloons.push({
        id: `b${result.balloons.length + 1}`,
        ...common,
        balloonBbox: ratio(unit.bbox),
        textBbox: ratio(unit.textBbox),
      } satisfies BalloonText);
    } else {
      result.looseText.push({ id: `l${result.looseText.length + 1}`, ...common, bbox: ratio(unit.bbox) } satisfies LooseText);
    }
  });
  return result;
}
