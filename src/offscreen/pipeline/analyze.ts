/**
 * 本機流水線的一個 Page（spec #27 第 3.3 節）：偵測 → 分組成 Balloon／Loose Text → 閱讀順序 → OCR → 讀音後備。
 * 移植自 prototype/local-ocr-pipeline 的 core.mjs（#7）。模型呼叫（onnxruntime-web）在 Engine 後面，這裡只有純邏輯。
 */
import type { BalloonText, LooseText, Orientation, PageText, RatioRect } from '../../shared/page-text.ts';
import { area, intersection, union, type PixelBox } from './boxes.ts';
import { fixNames, type Candidate, type SegmentNameFix } from './name-fix.ts';
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
  /** text 每個字解碼那一步的前幾名候選（機率高的在前），修名字用（#228）；沒有候選的字是 undefined。只在 offscreen 用完就丟。 */
  candidates?: (readonly Candidate[] | undefined)[];
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

/**
 * 裁切範圍碰到別段的文字框，就從碰到的那一邊切掉，讓 OCR 不讀進隔壁的字（重疊的 Balloon 會讓字黏在句首或句尾）。
 * 每次挑切掉自己的字最少的一邊，再來是留下鄰段的字最少的，最後是面積最大的；切完自己的文字框剩不到這個比例就不切，免得兩段大幅重疊時把自己的字切掉。
 */
const KEEP_OWN_TEXT = 0.8;

/** 算墨水的灰階門檻：比它暗的像素算字。 */
const INK = 128;

/**
 * [from, to) 之間沒有墨水的線（axis 'row'＝橫線、'column'＝直線），span 是線在另一軸的範圍；
 * 連續幾條都空白就取最長那段的中間。一條空白的都沒有時 undefined。
 */
function blankLine({ gray, width, height }: GrayImage, axis: 'row' | 'column', from: number, to: number, [s0, s1]: [number, number]): number | undefined {
  const limit = axis === 'row' ? height : width;
  const lines = Array.from({ length: Math.max(0, Math.min(limit, Math.ceil(to)) - Math.max(0, Math.floor(from))) }, (_, k) => Math.max(0, Math.floor(from)) + k);
  const otherLimit = axis === 'row' ? width : height;
  const a = Math.max(0, Math.floor(s0));
  const b = Math.min(otherLimit, Math.ceil(s1));
  const blank = lines.map((line) => {
    for (let s = a; s < b; s++) if (gray[axis === 'row' ? line * width + s : s * width + line]! < INK) return false;
    return true;
  });
  let best: { start: number; length: number } | undefined;
  for (let k = 0; k < blank.length; k++) {
    if (!blank[k] || (k > 0 && blank[k - 1])) continue;
    let end = k;
    while (end + 1 < blank.length && blank[end + 1]) end++;
    if (!best || end - k + 1 > best.length) best = { start: lines[k]!, length: end - k + 1 };
  }
  return best && best.start + best.length / 2;
}

/**
 * 從哪裡切：別段文字框的邊（edge）在自己文字框外就切在那條邊；落在自己文字框裡（偵測框常比字大一點，
 * 那條邊可能正好穿過自己的字），改切在那條邊與自己文字框靠鄰段那一邊（ownEdge）之間的空白，也就是兩段字之間。
 * 找不到空白（兩段的字真的疊在一起）照樣切在那條邊，由 KEEP_OWN_TEXT 決定切不切。
 * own 是自己文字框在這一軸的範圍，span 是線在另一軸要看的範圍（自己文字框在另一軸的範圍）。
 */
function cutLine(page: GrayImage, axis: 'row' | 'column', edge: number, ownEdge: number, own: [number, number], span: [number, number]): number {
  if (edge <= own[0] || edge >= own[1]) return edge;
  return blankLine(page, axis, Math.min(edge, ownEdge), Math.max(edge, ownEdge), span) ?? edge;
}

/** a 與 b 都蓋到的那塊（a、b 是框）；沒交集時寬或高是 0。 */
function overlap(a: PixelBox, b: PixelBox): PixelBox {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}

/** region 裡的墨水像素數；落在 except 裡的不算。 */
function inkIn({ gray, width, height }: GrayImage, [rx, ry, rw, rh]: PixelBox, except?: PixelBox): number {
  const [ex, ey, ew, eh] = except ?? [0, 0, 0, 0];
  let count = 0;
  for (let y = Math.max(0, Math.floor(ry)); y < Math.min(height, Math.ceil(ry + rh)); y++) {
    for (let x = Math.max(0, Math.floor(rx)); x < Math.min(width, Math.ceil(rx + rw)); x++) {
      if (x >= ex && x < ex + ew && y >= ey && y < ey + eh) continue;
      if (gray[y * width + x]! < INK) count++;
    }
  }
  return count;
}

function trimToNeighbours(crop: PixelBox, own: PixelBox, textBoxes: readonly PixelBox[], page: GrayImage): PixelBox {
  let box = crop;
  const [ox, oy, ow, oh] = own;
  const ownColumns: [number, number] = [ox, ox + ow];
  const ownRows: [number, number] = [oy, oy + oh];
  for (const other of textBoxes) {
    if (other === own || intersection(box, other) === 0) continue;
    const [x, y, w, h] = box;
    // 找空白只看自己文字框那一段：裁切範圍外擴的邊上常有 Balloon 框線斜斜穿過每一條線，切過去也不傷自己的字
    const right = cutLine(page, 'column', other[0], ox + ow, ownColumns, ownRows);
    const left = cutLine(page, 'column', other[0] + other[2], ox, ownColumns, ownRows);
    const bottom = cutLine(page, 'row', other[1], oy + oh, ownRows, ownColumns);
    const top = cutLine(page, 'row', other[1] + other[3], oy, ownRows, ownColumns);
    const cuts: PixelBox[] = [
      [x, y, right - x, h], // 切右邊
      [left, y, x + w - left, h], // 切左邊
      [x, y, w, bottom - y], // 切下面
      [x, top, w, y + h - top], // 切上面
    ];
    // 先挑切掉自己的字最少的，再挑留下鄰段的字最少的，最後才比面積：找到的空白可能只是自己字旁的留白，
    // 沿那裡切留得住自己的字，鄰段的字卻還在（鄰段文字框裡、自己文字框外的墨水）
    const ownInk = inkIn(page, overlap(box, own));
    const best = cuts
      .filter((c) => c[2] > 0 && c[3] > 0)
      .map((c) => ({ c, lost: ownInk - inkIn(page, overlap(c, own)), stray: inkIn(page, overlap(c, other), own) }))
      .sort((a, b) => a.lost - b.lost || a.stray - b.stray || area(b.c) - area(a.c))[0]?.c;
    if (best && intersection(best, own) >= area(own) * KEEP_OWN_TEXT) box = best;
  }
  return box;
}

/** 只有標點（例如臉被當成 Balloon 而 OCR 出「…」）的不算文字。 */
const hasText = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** 非標點字的最低信心低於這個值，整段當成 unreadable、不覆蓋（ADR 0009，數字來自 #140）。 */
const OCR_CONFIDENCE_THRESHOLD = 0.25;

/** 算最低信心時不看的字：標點、符號、空白、長音（ー 在 Unicode 算字母）。 */
const NOT_COUNTED = /[\p{P}\p{S}\p{Z}ーｰ]/u;

/** 非標點字的最低信心；沒有非標點字時 undefined。skip：不算的位置（用 Notes 修過的字，#228）。 */
function minConfidence({ text, confidences }: Recognized, skip: ReadonlySet<number>): number | undefined {
  const counted = [...text].flatMap((char, i) => (NOT_COUNTED.test(char) || skip.has(i) ? [] : [confidences[i] ?? 1]));
  return counted.length ? Math.min(...counted) : undefined;
}

/** 剪句尾雜訊時，信心低於這個值的字算不可靠（ADR 0009 的「句尾雜訊」）。 */
const SHAKY_CONFIDENCE = 0.5;
/** 剪完至少要留下這麼多個可靠的非標點字，才算「大部分可讀」。 */
const MIN_KEPT_CHARS = 4;

/**
 * 被門檻擋下的段，如果不可靠的字全擠在句尾（例如句尾加了假名注音的名字被讀成「177」），剪掉句尾那段、留下前面可靠的部分；
 * 不可靠的字夾在句子中間、或剪完剩太少，回傳 undefined（照樣整段 unreadable）。
 */
function dropShakyTail(ocr: Recognized, skip: ReadonlySet<number>): { kept: Recognized; dropped: string } | undefined {
  const chars = [...ocr.text];
  // 用 Notes 修過的字（#228）算可靠
  const shaky = (i: number) => !NOT_COUNTED.test(chars[i]!) && !skip.has(i) && (ocr.confidences[i] ?? 1) < SHAKY_CONFIDENCE;
  const lastSure = chars.findLastIndex((char, i) => !NOT_COUNTED.test(char) && !shaky(i));
  // 句尾那段從最後一個可靠字之後的第一個不可靠字開始；中間夾的標點跟著剪，可靠字後面原本的標點留著
  const cut = chars.findIndex((_, i) => i > lastSure && shaky(i));
  if (lastSure < 0 || cut < 0) return undefined;
  const head = chars.slice(0, cut);
  if (head.some((_, i) => shaky(i)) || head.filter((char) => !NOT_COUNTED.test(char)).length < MIN_KEPT_CHARS) return undefined;
  return { kept: { text: head.join(''), confidences: ocr.confidences.slice(0, cut) }, dropped: chars.slice(cut).join('') };
}

export interface AnalyzeOptions {
  /**
   * 收不收一個框（外框，0～1 比例）；不收的不做 OCR、不出現在結果。長 Page 用它擋掉被可見範圍切到的框
   * 與已收過的框（spec #142）；閱讀順序仍然看整頁的框排。
   */
  accept?: (box: RatioRect) => boolean;
  /** 這部 Series 的 Notes 條目原文：OCR 讀成形近字的名字換回來（#228）。 */
  notesNames?: readonly string[];
  /** 每修一處呼叫一次（id 是這段在結果裡的 id），給 trace 記。 */
  onNameFix?: (fix: SegmentNameFix) => void;
}

export async function analyzePage(engine: Engine, image: PageImage, reading: (ja: string) => string, { accept, notesNames = [], onNameFix }: AnalyzeOptions = {}): Promise<PageText> {
  const { width, height } = image;
  const ratio = ([x, y, w, h]: PixelBox): RatioRect => ({ x: x / width, y: y / height, w: w / width, h: h / height });
  const detections = nms((await engine.detect(image)).filter((d) => d.score >= SCORE_THRESHOLD));
  const gray = image.gray();
  const all = readingOrder(group(detections), gray);
  const units = all.filter((u) => accept?.(ratio(u.bbox)) ?? true);
  // accept 不收的段字還在圖上，裁切一樣要避開
  const textBoxes = all.map((u) => u.textBbox);
  const recognized = await engine.recognize(
    image,
    units.map((u) => trimToNeighbours(ocrBox(u.textBbox, width, height), u.textBbox, textBoxes, gray)),
  );
  const orientation = (b: PixelBox): Orientation => (b[3] >= b[2] ? 'vertical' : 'horizontal');

  const result: PageText = { balloons: [], looseText: [] };
  let order = 0;
  units.forEach((unit, i) => {
    const raw = recognized[i] ?? { text: '', confidences: [] };
    // 修名字在算信心、unreadable 與讀音之前：之後全部用修過的原文
    const fixed = fixNames(raw.text, raw.candidates ?? [], notesNames);
    if (!hasText(fixed.text)) return;
    order++;
    const { fixes } = fixed;
    const skip = new Set(fixes.map((f) => f.at));
    const named = { ...raw, text: fixed.text };
    const namedConfidence = minConfidence(named, skip);
    // 被門檻擋下時，不可靠的字全在句尾就剪掉那段（ADR 0009 的「句尾雜訊」）
    const trimmed = namedConfidence !== undefined && namedConfidence < OCR_CONFIDENCE_THRESHOLD ? dropShakyTail(named, skip) : undefined;
    const 原文 = trimmed?.kept.text ?? named.text;
    const ocrConfidence = trimmed ? minConfidence(trimmed.kept, skip) : namedConfidence;
    const common = {
      order,
      orientation: orientation(unit.textBbox),
      原文,
      讀音: reading(原文),
      讀音來源: 'kuromoji',
      譯文: '',
      unreadable: ocrConfidence !== undefined && ocrConfidence < OCR_CONFIDENCE_THRESHOLD,
      ...(ocrConfidence === undefined ? {} : { ocrConfidence }),
      ...(trimmed ? { ocrDropped: trimmed.dropped } : {}),
    } as const;
    const id = unit.kind === 'balloon' ? `b${result.balloons.length + 1}` : `l${result.looseText.length + 1}`;
    for (const fix of fixes) onNameFix?.({ id, ...fix });
    if (unit.kind === 'balloon') {
      result.balloons.push({
        id,
        ...common,
        balloonBbox: ratio(unit.bbox),
        textBbox: ratio(unit.textBbox),
      } satisfies BalloonText);
    } else {
      result.looseText.push({ id, ...common, bbox: ratio(unit.bbox) } satisfies LooseText);
    }
  });
  return result;
}
