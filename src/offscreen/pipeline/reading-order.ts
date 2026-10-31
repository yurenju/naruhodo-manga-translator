/**
 * 閱讀順序（spec #27 第 3.3 節）：flood fill 找 Panel＋XY-cut，確定性純函式，LLM 不改動。
 * 移植自 prototype/local-ocr-pipeline 的 core.mjs（#7）。
 */
import { area, intersection, type PixelBox } from './boxes.ts';

/** 灰階 ≥ 這個值算白色背景（頁邊與格間空白）。 */
const WHITE = 200;
/** 連通區塊至少佔頁面這個比例才算 Panel。 */
const MIN_PANEL_AREA = 0.01;
/** XY-cut 允許 bbox 互相咬到這麼多 px（斜切格線）。 */
const CUT_OVERLAP = 15;
/** 被另一個 Panel 的 bbox 包住、面積又小於它這個比例的區塊，算那個 Panel 的一部分。 */
const NESTED_MAX_RATIO = 0.1;

const contains = (outer: PixelBox, inner: PixelBox): boolean =>
  inner[0] >= outer[0] &&
  inner[1] >= outer[1] &&
  inner[0] + inner[2] <= outer[0] + outer[2] &&
  inner[1] + inner[3] <= outer[1] + outer[3];

export interface GrayImage {
  gray: Uint8Array;
  width: number;
  height: number;
}

interface Panel {
  id: number;
  bbox: PixelBox;
}

/**
 * 從四邊 flood fill 白色背景；剩下夠大的連通區塊就是 Panel（斜切格線也成立）。
 * 回傳依閱讀順序排好的 Panel，以及每個像素屬於哪個連通區塊（-1＝背景）。
 */
export function findPanels({ gray, width: w, height: h }: GrayImage): { panels: Panel[]; label: Int32Array } {
  const background = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!background[i] && gray[i]! >= WHITE) {
      background[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }

  const label = new Int32Array(w * h).fill(-1);
  const components: (Panel & { size: number })[] = [];
  for (let start = 0; start < w * h; start++) {
    if (background[start] || label[start]! >= 0) continue;
    const id = components.length;
    let size = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      size++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of neighbours) {
        if (j >= 0 && j < w * h && !background[j] && label[j]! < 0) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    components.push({ id, size, bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] });
  }
  const large = components.filter((c) => c.size >= MIN_PANEL_AREA * w * h);
  // 整個落在另一個 Panel 範圍裡的小區塊（旁白框、被切開的跨頁 Panel 裡的島）屬於外面那個 Panel，不自成一格。
  const panels = large
    .filter((c) => !large.some((o) => o !== c && contains(o.bbox, c.bbox) && area(c.bbox) < NESTED_MAX_RATIO * area(o.bbox)))
    .map(({ id, bbox }) => ({ id, bbox }));
  return { panels: xyCut(panels, topThenRight), label };
}

type Boxed = { bbox: PixelBox };

const right = (b: PixelBox) => b[0] + b[2];

/** 上面先讀，上緣一樣時右邊先讀。 */
const topThenRight = (a: Boxed, b: Boxed): number => a.bbox[1] - b.bbox[1] || right(b.bbox) - right(a.bbox);

/** 右邊先讀，右緣差不多（< 較窄寬度的 1/3）時上面先讀；最後用座標決勝，讓結果與輸入順序無關。 */
const rightThenTop = (a: Boxed, b: Boxed): number => {
  const ra = right(a.bbox);
  const rb = right(b.bbox);
  const tolerance = Math.min(a.bbox[2], b.bbox[2]) / 3;
  if (Math.abs(ra - rb) > tolerance) return rb - ra;
  return a.bbox[1] - b.bbox[1] || rb - ra || a.bbox[0] - b.bbox[0];
};

/** 先找水平空隙（上→下），再找垂直空隙（右→左）；切不開就用 fallback 排序。 */
function xyCut<T extends Boxed>(items: T[], fallback: (a: T, b: T) => number): T[] {
  if (items.length <= 1) return items;
  const split = (lo: (b: PixelBox) => number, hi: (b: PixelBox) => number): T[][] => {
    const intervals = items.map((it) => [lo(it.bbox), hi(it.bbox), it] as const).sort((a, b) => a[0] - b[0]);
    const groups: T[][] = [];
    let current: T[] = [];
    let end = -Infinity;
    for (const [a, b, it] of intervals) {
      if (current.length && a >= end - CUT_OVERLAP) {
        groups.push(current);
        current = [];
      }
      current.push(it);
      end = Math.max(end, b);
    }
    groups.push(current);
    return groups;
  };
  const rows = split((b) => b[1], (b) => b[1] + b[3]);
  if (rows.length > 1) return rows.flatMap((row) => xyCut(row, fallback));
  const columns = split((b) => b[0], (b) => b[0] + b[2]);
  if (columns.length > 1) return columns.reverse().flatMap((column) => xyCut(column, fallback));
  return items.slice().sort(fallback);
}

/**
 * 依日漫閱讀順序排列：Panel 依 XY-cut 順序；同一個 Panel 內的框也跑 XY-cut（跨格線的框會把好幾格連成一個 Panel），
 * 切不開才右邊先讀、右緣差不多時上面先讀。
 * 每個框以中心點所在的 Panel 歸屬；中心落在格間空白（橫跨格線的 Balloon）就歸到重疊最多的 Panel。
 */
export function readingOrder<T extends Boxed>(units: readonly T[], image: GrayImage): T[] {
  const { panels, label } = findPanels(image);
  const rank = new Map(panels.map((p, i) => [p.id, i]));
  const panelOf = (bbox: PixelBox): number => {
    const cx = Math.min(image.width - 1, Math.max(0, Math.round(bbox[0] + bbox[2] / 2)));
    const cy = Math.min(image.height - 1, Math.max(0, Math.round(bbox[1] + bbox[3] / 2)));
    const direct = rank.get(label[cy * image.width + cx]!);
    if (direct !== undefined) return direct;
    let best = 0;
    let index = panels.length;
    panels.forEach((p, i) => {
      const a = intersection(p.bbox, bbox);
      if (a > best) {
        best = a;
        index = i;
      }
    });
    return index;
  };
  const byPanel = new Map<number, T[]>();
  for (const unit of units) {
    const panel = panelOf(unit.bbox);
    byPanel.set(panel, [...(byPanel.get(panel) ?? []), unit]);
  }
  return [...byPanel.entries()].sort(([a], [b]) => a - b).flatMap(([, inPanel]) => xyCut(inPanel, rightThenTop));
}
