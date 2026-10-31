/**
 * 原地覆蓋的排版規則（spec #27 第 7.3、7.4 節）。純邏輯，不碰 DOM；量測由呼叫端注入。
 * 座標與字級的單位都是 Page 原始像素（Page 層再整層 scale 到畫面上）。
 */
import type { RatioRect } from '../shared/page-text.ts';

/** 一段譯文；upright＝縱中橫（text-combine-upright）。 */
export interface TextRun {
  text: string;
  upright: boolean;
}

const HALF_TO_FULL: Record<string, string> = { '!': '！', '?': '？', '~': '～', ',': '，' };

/** 1～3 字的英數字（前後不接英數字），或兩個全形驚嘆號／問號的組合。 */
const UPRIGHT = /(?<![0-9A-Za-z])[0-9A-Za-z]{1,3}(?![0-9A-Za-z])|[！？]{2}/g;

/** 直書前：半形 !?~, 與 ... 換成全形，短英數字縱中橫。 */
export function verticalize(text: string): TextRun[] {
  const full = text.replace(/\.{2,}|…+/g, '……').replace(/[!?~,]/g, (c) => HALF_TO_FULL[c]!);
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of full.matchAll(UPRIGHT)) {
    if (match.index > last) runs.push({ text: full.slice(last, match.index), upright: false });
    runs.push({ text: match[0], upright: true });
    last = match.index + match[0].length;
  }
  if (last < full.length) runs.push({ text: full.slice(last), upright: false });
  return runs;
}

/** Page 原始像素的矩形（跟 RatioRect 同形狀，但單位是像素）。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 四邊各外擴 m。 */
export const expandBox = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

/** 相對 Page 的比例座標換成 Page 像素；size 是 Page 的像素尺寸。 */
export const ratioToBox = (r: RatioRect, size: { width: number; height: number }): Box => ({
  x: r.x * size.width,
  y: r.y * size.height,
  w: r.w * size.width,
  h: r.h * size.height,
});

/** Page 像素換成相對 Page 的比例座標。 */
export const boxToRatio = (b: Box, size: { width: number; height: number }): RatioRect => ({
  x: b.x / size.width,
  y: b.y / size.height,
  w: b.w / size.width,
  h: b.h / size.height,
});

/** [x, y, w, h] 陣列（偵測器的 PixelBox、合成頁的 ground truth）換成 Box。 */
export const tupleBox = ([x, y, w, h]: readonly [number, number, number, number]): Box => ({ x, y, w, h });

/** 預設直書；只有上游標成橫書而且 Balloon 是寬的才橫書。 */
export function isVertical(orientation: 'vertical' | 'horizontal', balloon: Box): boolean {
  return !(orientation === 'horizontal' && balloon.w >= balloon.h);
}

/** 只擦文字框，外擴這麼多（不猜 Balloon 形狀，框線與尾巴保留）。 */
export const ERASE_PADDING = 3;

/**
 * 擦除底色怎麼畫：有擦除小圖（#149）就原樣貼上；舊快取、備份還原的頁，或擦除退回矩形時沒有小圖，
 * 用文字框外擴 ERASE_PADDING 的矩形塗 eraseLuminance（沒有時當白底）。
 */
export function eraseFill(balloon: {
  erase?: { box: { x: number; y: number; w: number; h: number }; image: string };
  eraseLuminance?: number;
}): { kind: 'image'; box: { x: number; y: number; w: number; h: number }; image: string } | { kind: 'rect'; luminance: number } {
  return balloon.erase ? { kind: 'image', ...balloon.erase } : { kind: 'rect', luminance: balloon.eraseLuminance ?? 255 };
}

const fromEdges = (left: number, top: number, right: number, bottom: number): Box => ({ x: left, y: top, w: right - left, h: bottom - top });

/**
 * erase：擦除範圍；fit1：第 1 階的譯文範圍（文字框外擴 Balloon 寬高的 12%，不超出 Balloon 往內 8%）；
 * fit2：第 2 階（Balloon 往內 10%，跟 fit1 取聯集，才不會比第 1 階小）。
 * 有排版矩形（#150，擦除範圍內最大的矩形）時，fit1、fit2 都跟它取交集，譯文才不出擦除範圍。
 */
export function textRegions(balloon: Box, text: Box, fit?: Box): { erase: Box; fit1: Box; fit2: Box } {
  const gx = balloon.w * 0.12;
  const gy = balloon.h * 0.12;
  const fit1 = fromEdges(
    Math.max(balloon.x + balloon.w * 0.08, text.x - gx),
    Math.max(balloon.y + balloon.h * 0.08, text.y - gy),
    Math.min(balloon.x + balloon.w * 0.92, text.x + text.w + gx),
    Math.min(balloon.y + balloon.h * 0.92, text.y + text.h + gy),
  );
  const fit2 = fromEdges(
    Math.min(fit1.x, balloon.x + balloon.w * 0.1),
    Math.min(fit1.y, balloon.y + balloon.h * 0.1),
    Math.max(fit1.x + fit1.w, balloon.x + balloon.w * 0.9),
    Math.max(fit1.y + fit1.h, balloon.y + balloon.h * 0.9),
  );
  const within = (r: Box) =>
    fit
      ? fromEdges(Math.max(r.x, fit.x), Math.max(r.y, fit.y), Math.min(r.x + r.w, fit.x + fit.w), Math.min(r.y + r.h, fit.y + fit.h))
      : r;
  return { erase: expandBox(text, ERASE_PADDING), fit1: within(fit1), fit2: within(fit2) };
}

/**
 * Loose Text（#151）：沒有泡泡外框，排版區就是文字框本身，第 2 階也不往外長（排不下就縮字）。不跟擦除範圍取交集：
 * 擦除範圍可能被保留下來的畫面線條切得很碎。erase 是沒有擦除小圖時的矩形退路。
 */
export function looseTextRegions(text: Box): { erase: Box; fit1: Box; fit2: Box } {
  // fit1、fit2 各自一份：separateRegions 會就地修改
  return { erase: expandBox(text, ERASE_PADDING), fit1: { ...text }, fit2: { ...text } };
}

const boxesOverlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 對話框疊在一起時偵測框也會重疊，譯文就排進隔壁的框裡（#27 除錯在 canvas 網站看到）。兩兩比對譯文範圍，
 * 重疊就沿著兩個文字框分得比較開的那一軸，在文字框相對的兩邊中間切一刀，各留在自己那一側。
 * 只改 fit1／fit2（就地修改）；擦除範圍不動，原文還是要整個蓋掉。
 */
export function separateRegions(items: { text: Box; fit1: Box; fit2: Box }[]): void {
  for (const [i, a] of items.entries()) {
    for (const b of items.slice(i + 1)) {
      if (!boxesOverlap(a.fit2, b.fit2)) continue;
      const gapX = Math.max(b.text.x - (a.text.x + a.text.w), a.text.x - (b.text.x + b.text.w));
      const gapY = Math.max(b.text.y - (a.text.y + a.text.h), a.text.y - (b.text.y + b.text.h));
      const [pos, size] = gapX >= gapY ? (['x', 'w'] as const) : (['y', 'h'] as const);
      const mid = (t: Box) => t[pos] + t[size] / 2;
      const [first, second] = mid(a.text) <= mid(b.text) ? [a, b] : [b, a];
      // 文字框重疊很多時中點可能越過自己的文字中心，夾在兩個中心之間
      const line = Math.min(Math.max((first.text[pos] + first.text[size] + second.text[pos]) / 2, mid(first.text)), mid(second.text));
      for (const key of ['fit1', 'fit2'] as const) {
        const f = first[key];
        if (f[pos] + f[size] > line) f[size] = line - f[pos];
        const s = second[key];
        if (s[pos] < line) {
          s[size] = s[pos] + s[size] - line;
          s[pos] = line;
        }
      }
    }
  }
}

/** 估不出原作字級時的起始字級（Page 像素）。 */
const START_PX = 26;
/** 原作的字寬 ≈ 這個比例 × √(文字框面積 ÷ 字數)（#80 用 10 個 debug session、621 個對話框量出來的）。 */
const INK_PER_CELL = 0.54;
/** 譯文字形的墨水寬約 0.9 em。 */
const INK_PER_EM = 0.9;
/** 保守係數：比估出來的原作字級小一點，之後可再調。 */
const FONT_ESTIMATE_FACTOR = 0.9;
/** 每框的字級夾在整頁中位數 ±這個比例內（守住「同一頁大小一致」，#81）。 */
const PAGE_FONT_SPREAD = 0.25;

/** 佔幾格：連續的點（...、・・・ 或 …）算 2 格（直書「……」），空白不算。 */
const cellCount = (text: string) => [...text.replace(/[.・]{2,}|…+/g, '……').replace(/\s/g, '')].length;

/** √(文字框面積 ÷ 字數)：一個字分到的格子邊長；沒有字或沒有面積就是 undefined。 */
function cellSize(text: Box, content: string): number | undefined {
  const count = cellCount(content);
  return text.w * text.h > 0 && count > 0 ? Math.sqrt((text.w * text.h) / count) : undefined;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * 每個 Balloon 的起始字級（Page 像素）：用文字框與譯文字數估「把譯文撐滿文字框」的字級（中文比日文短，
 * 用原文字數估會偏小，#81），再夾在整頁中位數 ±PAGE_FONT_SPREAD。估不出的框用整頁中位數；整頁都沒得估就用 START_PX。
 */
export function estimateFontPx(balloons: { text: Box; 譯文: string }[]): number[] {
  const sizes = balloons.map(({ text, 譯文 }) => {
    const cell = cellSize(text, 譯文);
    return cell === undefined ? undefined : (cell * INK_PER_CELL * FONT_ESTIMATE_FACTOR) / INK_PER_EM;
  });
  const known = sizes.filter((size) => size !== undefined);
  if (known.length === 0) return balloons.map(() => START_PX);
  const page = median(known);
  return sizes.map((size) => (size === undefined ? page : Math.min(Math.max(size, page * (1 - PAGE_FONT_SPREAD)), page * (1 + PAGE_FONT_SPREAD))));
}

/** 原作的字距 ≈ 字寬 × 這個比例（#81 量了好幾本，都在 1.15～1.24）。 */
const PITCH_PER_INK = 1.21;

/** 原文排成幾行：一行放 ⌊文字框沿著行的長度 ÷ 原作字距⌋ 個字。估不出就當 1 行。 */
export function estimateOriginalLines(text: Box, 原文: string, vertical: boolean): number {
  const cell = cellSize(text, 原文);
  if (cell === undefined) return 1;
  const perLine = Math.max(1, Math.floor((vertical ? text.h : text.w) / (cell * INK_PER_CELL * PITCH_PER_INK)));
  return Math.ceil(cellCount(原文) / perLine);
}

const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
/** 不能放行首（黏到前一段）：標點、刪節號、破折號、右括號。 */
const NO_LINE_START = /^[，。、！？；：…—～）」』》〉,.!?;:~)\]]/;
/** 不能放行尾（黏到下一段）：左括號結尾的。 */
const NO_LINE_END = /[（「『《〈(\[]$/;
/** 整個詞是數字、「第」＋數字或英數字的，跟後面的量詞黏在一起（四個人、10級、B級、第一層）。 */
const NUMBER = /^(第?[0-9０-９一二三四五六七八九十百千兩幾]*|[0-9A-Za-z０-９]+)$/;
/** 斷在這些後面最自然。 */
const PUNCTUATION_END = /[，。、！？；：…—～」』）,.!?;:~)]$/;
/**
 * 斷點的代價（單位跟行長平方差一樣是「格²」）：不在標點後斷 BREAK_COST；斷點一邊是單字再加 SINGLE_SIDE_COST，
 * 兩邊都是單字改加 SINGLE_BOTH_COST（多半是斷詞器不認得的詞，如「地｜城」）。行數每偏離原文一行 LINE_COUNT_COST。
 */
const BREAK_COST = 1.5;
const SINGLE_SIDE_COST = 0.75;
const SINGLE_BOTH_COST = 3;
const LINE_COUNT_COST = 2;

function breakCost(before: string, after: string): number {
  if (PUNCTUATION_END.test(before)) return 0;
  const singles = [before, after].filter((unit) => cellCount(unit) === 1).length;
  return BREAK_COST + [0, SINGLE_SIDE_COST, SINGLE_BOTH_COST][singles]!;
}

/** 斷成不能再切的單位：詞界，再套避頭尾與數量詞黏合；空白跟著前一個詞（英文字之間的空白保留，句首的丟掉）。 */
function lineUnits(text: string): string[] {
  const units: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const last = units.at(-1);
    if (last === undefined) {
      if (!/^\s+$/.test(segment)) units.push(segment);
    } else if (/^\s+$/.test(segment) || NO_LINE_START.test(segment) || NO_LINE_END.test(last) || NUMBER.test(last)) units[units.length - 1] = last + segment;
    else units.push(segment);
  }
  return units;
}

/** 把單位排成剛好 n 行：成本＝各行長度離平均的平方和＋每個斷點的 breakCost，用 DP 取最小。 */
function bestLines(units: string[], n: number): { cost: number; lines: string[] } {
  const lengths = units.map(cellCount);
  const average = lengths.reduce((a, b) => a + b, 0) / n;
  // best[k][i]：前 i 個單位排成 k 行的最小成本，與最後一行從哪個單位開始
  const best: { cost: number; from: number }[][] = Array.from({ length: n + 1 }, () => []);
  best[0]![0] = { cost: 0, from: 0 };
  for (let k = 1; k <= n; k++)
    for (let i = k; i <= units.length; i++)
      for (let j = k - 1; j < i; j++) {
        const prev = best[k - 1]![j];
        if (!prev) continue;
        const length = lengths.slice(j, i).reduce((a, b) => a + b, 0);
        const cost = prev.cost + (length - average) ** 2 + (i < units.length ? breakCost(units[i - 1]!, units[i]!) : 0);
        if (!best[k]![i] || cost < best[k]![i]!.cost) best[k]![i] = { cost, from: j };
      }
  const lines: string[] = [];
  for (let k = n, i = units.length; k > 0; k--) {
    const { from } = best[k]![i]!;
    lines.unshift(units.slice(from, i).join(''));
    i = from;
  }
  return { cost: best[n]![units.length]!.cost, lines };
}

/**
 * 譯文斷成幾行的候選（#81）：只在詞與詞之間斷、守避頭尾，行數取原文行數 ±1；cost 含每偏離一行的 LINE_COUNT_COST，
 * 所以能斷在標點後、或各行比較平均時，寧可多一行或少一行。單位比這些行數都少，就一個單位一行。
 */
function lineCandidates(譯文: string, targetLines: number): { cost: number; lines: string[] }[] {
  const units = lineUnits(譯文);
  if (units.length <= 1) return [{ cost: 0, lines: [units.join('')] }];
  const counts = [targetLines - 1, targetLines, targetLines + 1].filter((n) => n >= 1 && n <= units.length);
  return (counts.length > 0 ? counts : [units.length]).map((n) => {
    const { cost, lines } = bestLines(units, n);
    return { cost: cost + Math.abs(n - targetLines) * LINE_COUNT_COST, lines };
  });
}

const cheapest = <T extends { cost: number }>(candidates: T[]): T => candidates.reduce((a, b) => (b.cost < a.cost ? b : a));

/** 只看扣分的斷法（不量字級）。 */
export function breakLines(譯文: string, targetLines: number): string[] {
  return cheapest(lineCandidates(譯文, targetLines)).lines;
}

/** 最小畫面字級（畫面 px）。canvas 網站顯示倍率約 0.49×，只看 Page 像素的話 14px 在畫面上只剩約 7px。 */
export const MIN_SCREEN_FONT_PX = 9;

/** 顯示倍率（畫面 px ÷ Page 像素）下，最小畫面字級換算回 Page 像素。 */
export function minLayerFontPx(displayScale: number, minScreenPx = MIN_SCREEN_FONT_PX): number {
  return minScreenPx / displayScale;
}

/** fitText 要量的對象：把譯文套上範圍與字級，再問有沒有溢出（實際量測，不用面積估算）。 */
export interface FitTarget {
  apply(region: Box, size: number): void;
  overflows(): boolean;
}

export interface FitResult {
  stage: 1 | 2 | 3;
  size: number;
  region: Box;
  /** 第 3 階：放不下的部分截斷，滑過時 tooltip 顯示全文。 */
  truncated: boolean;
}

const STAGE_FLOORS = [14, 12, 10] as const;

/** 從 start 每次 −1 縮到 floor；floor 不是整數時最後也試 floor 本身；start 比 floor 小就只試 floor。 */
function sizesDownTo(start: number, floor: number): number[] {
  const sizes: number[] = [];
  for (let size = start; size >= floor; size--) sizes.push(size);
  if (sizes.at(-1) !== floor) sizes.push(floor);
  return sizes;
}

/**
 * 三階段：1. fit1 內從 startPx 縮到 14px；2. 擴到 fit2 再從 startPx 縮到 12px；3. 10px 並截斷。
 * startPx 是 estimateFontPx 估的這框字級，沒有就 26px。
 * 每一階的下限都不小於 minLayerPx（最小畫面字級換算回 Page 像素）。
 */
export function fitText(target: FitTarget, regions: { fit1: Box; fit2: Box }, minLayerPx: number, startPx = START_PX): FitResult {
  const stages = [
    { stage: 1 as const, region: regions.fit1, floor: Math.max(STAGE_FLOORS[0], minLayerPx) },
    { stage: 2 as const, region: regions.fit2, floor: Math.max(STAGE_FLOORS[1], minLayerPx) },
  ];
  for (const { stage, region, floor } of stages) {
    for (const size of sizesDownTo(startPx, floor)) {
      target.apply(region, size);
      if (!target.overflows()) return { stage, size, region, truncated: false };
    }
  }
  const size = Math.max(STAGE_FLOORS[2], minLayerPx);
  target.apply(regions.fit2, size);
  return { stage: 3, size, region: regions.fit2, truncated: true };
}

/** 字級差在這個比例內視為一樣大，改用扣分決定（#129）。 */
const SIZE_TIE = 0.05;

/** layoutText 要量的對象：fitText 的量測，再加上換一種斷法。 */
export interface LayoutTarget extends FitTarget {
  setLines(lines: string[]): void;
}

/**
 * 行數和字級一起挑（#129）：lineCandidates 的每個候選行數各自跑 fitText，取字級最大的；字級差在 SIZE_TIE 內就看扣分。
 * 截斷的候選排在沒截斷的後面（刻意的）：截斷的字只在 tooltip 看得到，寧可字小一點也要整句排得下；
 * 每個候選都截斷時才取字級最大的。量完把選中的斷法與字級套回 target。
 */
export function layoutText(
  target: LayoutTarget,
  譯文: string,
  targetLines: number,
  regions: { fit1: Box; fit2: Box },
  minLayerPx: number,
  startPx = START_PX,
): FitResult & { lines: string[] } {
  const fitted = lineCandidates(譯文, targetLines).map(({ cost, lines }) => {
    target.setLines(lines);
    return { cost, lines, ...fitText(target, regions, minLayerPx, startPx) };
  });
  const whole = fitted.filter((candidate) => !candidate.truncated);
  const pool = whole.length > 0 ? whole : fitted;
  const largest = Math.max(...pool.map((candidate) => candidate.size));
  const { cost: _, ...chosen } = cheapest(pool.filter((candidate) => candidate.size >= largest * (1 - SIZE_TIE)));
  target.setLines(chosen.lines);
  target.apply(chosen.region, chosen.size);
  return chosen;
}

/** anchor 的 offset*（不含 transform；捲動、祖先 transform、overflow 裁切交給瀏覽器自然套用）。 */
export interface AnchorOffset {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
}

/** subRect：Page 在 anchor 裡的 0～1 範圍（單頁是整個 anchor，Spread 是一半）。 */
export interface SubRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Page 原始像素：anchor 的原圖尺寸（canvas.width／img.naturalWidth）× subRect；不知道時用畫面大小。 */
export function pageSize(intrinsic: { width: number; height: number }, sub: SubRect, anchor: AnchorOffset): { width: number; height: number } {
  const width = intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic.width : anchor.offsetWidth;
  const height = intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic.height : anchor.offsetHeight;
  return { width: width * sub.w, height: height * sub.h };
}

/** Page 層的 transform：translate(x, y) scale(scaleX, scaleY)，transform-origin 0 0。 */
export function layerTransform(anchor: AnchorOffset, sub: SubRect, page: { width: number; height: number }) {
  return {
    x: anchor.offsetLeft + sub.x * anchor.offsetWidth,
    y: anchor.offsetTop + sub.y * anchor.offsetHeight,
    scaleX: (sub.w * anchor.offsetWidth) / page.width,
    scaleY: (sub.h * anchor.offsetHeight) / page.height,
  };
}
