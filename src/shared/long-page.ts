/**
 * 直式捲動的長 Page（spec #142「直式捲動的長 Page」、ADR 0004）：比可見範圍高的 Page 跟著捲動一截一截辨識。
 * 這裡是純函式：Page 身分（固定橫條指紋）、哪些框要收、收進來的 Line 怎麼排。
 */
import type { Rect } from './messages.ts';
import { hammingDistance, pageHash, SAME_PAGE_MAX_DISTANCE, type GrayImage } from './page-hash.ts';
import type { BalloonText, LooseText, PageText, RatioRect } from './page-text.ts';

/** 長 Page 的一條橫條：從上面數第幾條（0 起算）與它的 perceptual hash。 */
export interface Stripe {
  index: number;
  hash: string;
}

/** 橫條的高度是 Page 寬度的這個比例：用比例定義，改變縮放後同一條還是同樣的內容。 */
const STRIPE_HEIGHT = 1 / 4;

/**
 * 亮度標準差至少這麼多才算「有內容」：空白（直式捲動漫畫格子之間的大片留白）的 hash 只是雜訊，
 * 拿來比對會讓不同的頁互相認錯。合成頁一條有字的橫條約 40 以上，純白是 0。
 */
const MIN_STRIPE_CONTRAST = 8;

function contrast({ gray }: GrayImage): number {
  let sum = 0;
  let squares = 0;
  for (const v of gray) {
    sum += v;
    squares += v * v;
  }
  const mean = sum / gray.length;
  return Math.sqrt(Math.max(0, squares / gray.length - mean * mean));
}

/** Page 裡的一段列（像素，跟 stripeFingerprint 的 offset 同一個縮放），上緣含、下緣不含。 */
export interface RowSpan {
  top: number;
  bottom: number;
}

/**
 * 截到的一截（寬＝整個 Page 寬）裡完整看得到、有內容的橫條各算一個 hash。
 * offset：這一截的第一列在 Page 裡是第幾個像素（同一個縮放）。
 * covered：自己的覆蓋層（擦除、譯文）蓋住的列。長 Page 截圖時不藏覆蓋層，跟它有交集的橫條算出來的是蓋著中文的樣子，
 * 之後（例如重新整理後還沒蓋上時）對不上原稿，所以不算；只記乾淨的橫條。
 */
export function stripeFingerprint(slice: GrayImage, offset: number, covered: readonly RowSpan[] = []): Stripe[] {
  const height = slice.width * STRIPE_HEIGHT;
  const stripes: Stripe[] = [];
  // 四捨五入留半個像素的餘裕：Page 的位置換算成截圖像素時有小數
  for (let index = Math.max(0, Math.ceil(offset / height - 0.01)); (index + 1) * height <= offset + slice.height + 0.5; index++) {
    if (covered.some((c) => c.top < (index + 1) * height && c.bottom > index * height)) continue;
    const top = Math.max(0, Math.round(index * height - offset));
    const rows = Math.min(slice.height - top, Math.round(height));
    const stripe = { gray: slice.gray.subarray(top * slice.width, (top + rows) * slice.width), width: slice.width, height: rows };
    if (contrast(stripe) >= MIN_STRIPE_CONTRAST) stripes.push({ index, hash: pageHash(stripe) });
  }
  return stripes;
}

/** 兩份指紋第一條對得上的橫條（同一個位置、hash 在門檻內）是第幾條；對不上是 undefined。 */
export function matchingStripe(a: readonly Stripe[], b: readonly Stripe[]): number | undefined {
  return a.find((s) => b.some((t) => t.index === s.index && hammingDistance(s.hash, t.hash) <= SAME_PAGE_MAX_DISTANCE))?.index;
}

/** 兩份指紋是不是同一個長 Page：任何一條橫條對得上就是。 */
export function sameLongPage(a: readonly Stripe[], b: readonly Stripe[]): boolean {
  return matchingStripe(a, b) !== undefined;
}

/** 長 Page 看得到的一截在 Page 裡的範圍（Page 高度的比例 0～1）；寬度一律是整個 Page。 */
export interface Slice {
  top: number;
  bottom: number;
}

/** 偵測框離這一截的上下緣這麼多截圖像素以內，就當成被邊緣切到（被切開的字，框會貼著截圖邊）。 */
const EDGE_PX = 2;

/** 看得到的那一截（CSS px，content script 量的）在 Page 裡的範圍。 */
export function sliceOf(page: Rect, visible: Rect): Slice {
  return { top: (visible.y - page.y) / page.height, bottom: (visible.y + visible.height - page.y) / page.height };
}

/** 一截裡的比例座標換成 Page 座標：x 不變，y 依這一截在 Page 裡的範圍換算。 */
export function toPageBox(box: RatioRect, { top, bottom }: Slice): RatioRect {
  const height = bottom - top;
  return { x: box.x, y: top + box.y * height, w: box.w, h: box.h * height };
}

/** 一截的辨識結果整份換成 Page 座標。 */
export function toPageText({ balloons, looseText }: PageText, slice: Slice): PageText {
  return {
    balloons: balloons.map((b) => ({
      ...b,
      balloonBbox: toPageBox(b.balloonBbox, slice),
      textBbox: toPageBox(b.textBbox, slice),
      ...(b.erase
        ? { erase: { ...b.erase, box: toPageBox(b.erase.box, slice), ...(b.erase.fit ? { fit: toPageBox(b.erase.fit, slice) } : {}) } }
        : {}),
    })),
    looseText: looseText.map((l) => ({
      ...l,
      bbox: toPageBox(l.bbox, slice),
      ...(l.erase ? { erase: { ...l.erase, box: toPageBox(l.erase.box, slice) } } : {}),
    })),
  };
}

const overlaps = (a: RatioRect, b: RatioRect) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + 1e-9 && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + 1e-9;

/**
 * 這一截裡偵測到的框（相對這一截的比例座標）收不收：
 * - cut：被可見範圍的上緣或下緣切到（Page 本身的上下緣不算），先不收，等它完整出現再收。
 * - tooTall：上下都被切到，比可見範圍還高，永遠收不到（已知限制，記一筆）。
 * - overlap：跟已收 Line（Page 座標）重疊。截圖不藏長 Page 的覆蓋層，蓋著的譯文可能被偵測成新的框，所以一律丟掉。
 * sliceHeight：這一截在截圖上的像素高度。
 */
export function rejectInSlice(box: RatioRect, slice: Slice, sliceHeight: number, collected: readonly RatioRect[]): 'cut' | 'tooTall' | 'overlap' | undefined {
  const edge = EDGE_PX / sliceHeight;
  const cutTop = slice.top > 0 && box.y <= edge;
  const cutBottom = slice.bottom < 1 && box.y + box.h >= 1 - edge;
  if (cutTop && cutBottom) return 'tooTall';
  if (cutTop || cutBottom) return 'cut';
  const onPage = toPageBox(box, slice);
  if (collected.some((c) => overlaps(c, onPage))) return 'overlap';
  return undefined;
}

type Line = (BalloonText & { kind: 'balloon' }) | (LooseText & { kind: 'loose' });

const outerBox = (line: BalloonText | LooseText): RatioRect => ('balloonBbox' in line ? line.balloonBbox : line.bbox);

/** 已收 Line 的外框（Page 座標）：新的一截裡跟它們重疊的框不收。 */
export function collectedBoxes({ balloons, looseText }: PageText): RatioRect[] {
  return [...balloons, ...looseText].map(outerBox);
}

const centerY = (line: Line) => {
  const box = outerBox(line);
  return box.y + box.h / 2;
};

const linesOf = ({ balloons, looseText }: PageText): Line[] =>
  [...balloons.map((b) => ({ ...b, kind: 'balloon' as const })), ...looseText.map((l) => ({ ...l, kind: 'loose' as const }))].sort((a, b) => a.order - b.order);

/** 同一次截圖裡上下重疊的框連成一組，組內照偵測器的順序；每組用最上面的框中心排。 */
function verticalGroups(lines: Line[]): { key: number; lines: Line[] }[] {
  const groups: { top: number; bottom: number; lines: Line[] }[] = [];
  for (const line of lines) {
    const box = outerBox(line);
    const touching = groups.filter((g) => box.y < g.bottom && box.y + box.h > g.top);
    const merged = { top: Math.min(box.y, ...touching.map((g) => g.top)), bottom: Math.max(box.y + box.h, ...touching.map((g) => g.bottom)), lines: [...touching.flatMap((g) => g.lines), line] };
    groups.splice(0, groups.length, ...groups.filter((g) => !touching.includes(g)), merged);
  }
  return groups
    .map((g) => ({ key: Math.min(...g.lines.map(centerY)), lines: g.lines.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.key - b.key);
}

/**
 * 新的一截收到的 Line（Page 座標、偵測器的閱讀順序）併進長 Page（spec #142：side panel 依框中心的 y 由上到下排）。
 * 已收 Line 的相對順序不變；新的每一組插在第一個比它低的已收 Line 前面。id 接著已收的編號。
 */
export function addLines(existing: PageText, added: PageText): PageText {
  const old = linesOf(existing);
  const next = (prefix: string, ids: string[]) => {
    let n = Math.max(0, ...ids.map((id) => Number(id.slice(prefix.length)) || 0));
    return () => `${prefix}${++n}`;
  };
  const nextBalloon = next('b', existing.balloons.map((b) => b.id));
  const nextLoose = next('l', existing.looseText.map((l) => l.id));
  const renamed = linesOf(added).map((line): Line => ({ ...line, id: line.kind === 'balloon' ? nextBalloon() : nextLoose() }));
  // 已收 Line 依順序算「到這裡為止最低的中心」：插入位置只看它，原本照偵測器順序排的組才不會被拆開
  let lowest = -Infinity;
  const reach = old.map((line) => (lowest = Math.max(lowest, centerY(line))));
  const ordered = [...old];
  // 由上往下插，每組插在那個已收 Line 的正前面：插在同一個 Line 前面的幾組也照上下順序
  for (const group of verticalGroups(renamed)) {
    const before = old[reach.findIndex((y) => y > group.key)];
    ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, ...group.lines);
  }
  const numbered = ordered.map((line, i) => ({ ...line, order: i + 1 }));
  const strip = <T extends Line>({ kind: _, ...rest }: T) => rest;
  return {
    balloons: numbered.filter((l) => l.kind === 'balloon').map(strip) as BalloonText[],
    looseText: numbered.filter((l) => l.kind === 'loose').map(strip) as LooseText[],
  };
}

/** 整個 Page 裡 id 相同的 Line 換成 part 裡的（翻好的那幾句併回去）。 */
export function replaceLines(page: PageText, part: PageText): PageText {
  const balloons = new Map(part.balloons.map((b) => [b.id, b]));
  const looseText = new Map(part.looseText.map((l) => [l.id, l]));
  return { balloons: page.balloons.map((b) => balloons.get(b.id) ?? b), looseText: page.looseText.map((l) => looseText.get(l.id) ?? l) };
}

/** 只留 ids 裡的 Line。 */
export function pickLines(page: PageText, ids: ReadonlySet<string>): PageText {
  return { balloons: page.balloons.filter((b) => ids.has(b.id)), looseText: page.looseText.filter((l) => ids.has(l.id)) };
}
