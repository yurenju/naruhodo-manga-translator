/**
 * 擦除小圖（#149，spec #142「擦除範圍與顏色」）：擦除範圍沿泡泡內緣長出來，顏色從背景像素往內內插。
 * 結果是一張 RGBA 小圖（像素是顏色，alpha 是擦除範圍），content script 原樣貼回原位。
 */
import { ERASE_PADDING, expandBox, type Box } from '../content/overlay-layout.ts';
import { luma, type RgbaImage } from '../shared/pixels.ts';
import type { PixelBox } from './pipeline/boxes.ts';
import { eraseLuminance } from './erase-color.ts';

export interface EraseImage {
  /** 小圖在 Page 上的位置（Page 原始像素，整數）。 */
  box: PixelBox;
  /** box 大小的 RGBA；alpha 255＝擦除、0＝保留原圖。 */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** Balloon 的擦除小圖多帶排版矩形；Loose Text（eraseLooseText）的排版區是文字框本身，不帶。 */
export interface BalloonEraseImage extends EraseImage {
  /** 排版矩形（#150）：擦除範圍內面積最大的軸對齊矩形（Page 原始像素，整數），譯文只排在這裡面。 */
  fit: PixelBox;
}

/** 往外長的範圍：Balloon 外框再外擴這麼多，框線外側才碰得到範圍邊緣。 */
const BALLOON_MARGIN = 4;
/** 沒有 Balloon 外框時，往外長的範圍是文字框外擴這麼多。 */
const TEXT_MARGIN = 10;
/** 起點：亮度跟擦除底色差這麼多以內。 */
const SEED_TOLERANCE = 24;
/** 往外長：相鄰像素的亮度差這麼多以內（#128 的 prototype）。 */
const STEP_TOLERANCE = 10;
/** 內插後在未知像素上再做幾輪鄰點平均，修掉金字塔放大的稜角。 */
const SMOOTHING_SWEEPS = 8;

/**
 * balloon 等於 text 代表沒有外框（沒有 bubble 的 text_bubble），範圍改用文字框附近。
 * 文字框中央找不到接近底色的像素時回傳 undefined，由呼叫端退回矩形加單色 eraseLuminance。
 */
export function eraseImage(page: RgbaImage, balloon: Box, text: Box): BalloonEraseImage | undefined {
  const framed = balloon.x !== text.x || balloon.y !== text.y || balloon.w !== text.w || balloon.h !== text.h;
  const grow = framed ? expandBox(balloon, BALLOON_MARGIN) : expandBox(text, TEXT_MARGIN);
  // 擦除範圍最多到文字框外擴 ERASE_PADDING（跟矩形退路一樣）
  const clip = expandBox(text, ERASE_PADDING);
  // 計算的視窗：往外長的範圍與擦除範圍的聯集，夾在 Page 內
  const left = Math.max(0, Math.floor(Math.min(grow.x, clip.x)));
  const top = Math.max(0, Math.floor(Math.min(grow.y, clip.y)));
  const right = Math.min(page.width, Math.ceil(Math.max(grow.x + grow.w, clip.x + clip.w)));
  const bottom = Math.min(page.height, Math.ceil(Math.max(grow.y + grow.h, clip.y + clip.h)));
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return undefined;

  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      gray[y * w + x] = Math.round(luma(page.data, ((top + y) * page.width + left + x) * 4));
  const local = (b: Box): Box => ({ x: b.x - left, y: b.y - top, w: b.w, h: b.h });
  const base = eraseLuminance({ gray, width: w, height: h }, local(clip));

  // 起點：文字框中央一半範圍內、接近底色的像素
  const t = local(text);
  const seeds: number[] = [];
  for (let y = Math.max(0, Math.floor(t.y + t.h / 4)); y < Math.min(h, Math.ceil(t.y + (3 * t.h) / 4)); y++)
    for (let x = Math.max(0, Math.floor(t.x + t.w / 4)); x < Math.min(w, Math.ceil(t.x + (3 * t.w) / 4)); x++)
      if (Math.abs(gray[y * w + x]! - base) <= SEED_TOLERANCE) seeds.push(y * w + x);
  if (seeds.length === 0) return undefined;

  // 長到的背景（1）；被背景包住的部分（2）：從視窗邊緣走不到的非背景像素（墨水、白描邊）
  const BACKGROUND = 1;
  const ENCLOSED = 2;
  const g = local(grow);
  const inGrow = (x: number, y: number) => x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h;
  const label = new Uint8Array(w * h);
  flood(w, h, seeds, (from, to) => label[to] === 0 && inGrow(to % w, Math.floor(to / w)) && Math.abs(gray[to]! - gray[from]!) <= STEP_TOLERANCE, (i) => (label[i] = BACKGROUND));
  const outside = new Uint8Array(w * h);
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  flood(w, h, border.filter((i) => label[i] === 0), (_, to) => label[to] === 0 && outside[to] === 0, (i) => (outside[i] = 1));
  for (let i = 0; i < w * h; i++) if (label[i] === 0 && outside[i] === 0) label[i] = ENCLOSED;

  // 已知顏色：長到的背景，但不貼著被包住的部分（字邊的反鋸齒像素也會被長到，不能拿來當顏色）
  const known = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== BACKGROUND) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && label[ny * w + nx] === ENCLOSED) touches = true;
        }
      known[y * w + x] = touches ? 0 : 1;
    }
  const c = local(clip);
  const bx = Math.max(0, Math.round(c.x));
  const by = Math.max(0, Math.round(c.y));
  const bw = Math.min(w, Math.round(c.x + c.w)) - bx;
  const bh = Math.min(h, Math.round(c.y + c.h)) - by;
  if (bw <= 0 || bh <= 0) return undefined;
  // 擦除範圍：長到的背景與被包住的部分，跟文字框＋padding 取交集。已知像素用原圖顏色，其餘內插
  const wanted: number[] = [];
  for (let y = by; y < by + bh; y++)
    for (let x = bx; x < bx + bw; x++) if (label[y * w + x] !== 0 && !known[y * w + x]) wanted.push(y * w + x);
  const colors = interpolate(page, left, top, w, h, known, wanted, base);
  const rgba = new Uint8ClampedArray(bw * bh * 4);
  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = (by + y) * w + bx + x;
      if (label[i] === 0) continue;
      const o = (y * bw + x) * 4;
      rgba[o] = colors[i * 3]!;
      rgba[o + 1] = colors[i * 3 + 1]!;
      rgba[o + 2] = colors[i * 3 + 2]!;
      rgba[o + 3] = 255;
      mask[y * bw + x] = 1;
    }
  const [fx, fy, fw, fh] = largestRect(mask, bw, bh);
  return { box: [left + bx, top + by, bw, bh], rgba, fit: [left + bx + fx, top + by + fy, fw, fh] };
}

/**
 * mask（非 0＝範圍內）裡面積最大的軸對齊矩形，[x, y, w, h]；沒有範圍時寬高是 0。
 * 逐列累計每欄往上連續的高度，再用單調堆疊求每列長條圖裡最大的矩形，O(w × h)。
 */
export function largestRect(mask: ArrayLike<number>, w: number, h: number): PixelBox {
  const heights = new Int32Array(w);
  const stack = new Int32Array(w + 1);
  let best: PixelBox = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) heights[x] = mask[y * w + x] ? heights[x]! + 1 : 0;
    let top = 0;
    for (let x = 0; x <= w; x++) {
      const height = x < w ? heights[x]! : 0;
      while (top > 0 && heights[stack[top - 1]!]! >= height) {
        const barHeight = heights[stack[--top]!]!;
        const left = top > 0 ? stack[top - 1]! + 1 : 0;
        if (barHeight * (x - left) > best[2] * best[3]) best = [left, y - barHeight + 1, x - left, barHeight];
      }
      stack[top++] = x;
    }
  }
  return best;
}

/** 殘留墨水：亮度跟擦除底色差這麼多以上。 */
const INK_TOLERANCE = 64;
/**
 * Loose Text 擦完後，文字框中央一半範圍內沒擦到的墨水超過這個比例，就退回矩形（#151 的 prototype）：合成頁 p09 的
 * 5 段都是 0；2px 細線穿過 60px 的文字框約 6.7%（線要保留）；字黏在線上沒擦掉時是幾成。
 */
const LOOSE_RESIDUE_LIMIT = 0.08;

/**
 * Loose Text 的擦除小圖（#151，spec #142「Loose Text 原地覆蓋」）：沒有泡泡框線擋著，所以範圍只在文字框附近
 * （eraseImage 的「沒有外框」）。字碰到畫面線條、沿字擦不掉而殘留時，或中央找不到底色時，改成整個文字框＋padding
 * 的矩形，顏色一樣從背景內插。一定有小圖。
 */
export function eraseLooseText(page: RgbaImage, text: Box): EraseImage {
  const grown = eraseImage(page, text, text);
  return grown && residue(page, grown, text) <= LOOSE_RESIDUE_LIMIT ? grown : eraseRect(page, text);
}

/** 文字框中央一半範圍內，沒被擦到、又跟底色差很多（墨水）的像素比例。 */
function residue(page: RgbaImage, erase: EraseImage, text: Box): number {
  const [ex, ey, ew, eh] = erase.box;
  const { gray, left, top, w } = grayWindow(page, expandBox(text, ERASE_PADDING));
  const base = eraseLuminance({ gray, width: w, height: gray.length / w }, { x: 0, y: 0, w, h: gray.length / w });
  let ink = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(text.y + text.h / 4)); y < Math.min(page.height, Math.ceil(text.y + (3 * text.h) / 4)); y++)
    for (let x = Math.max(0, Math.floor(text.x + text.w / 4)); x < Math.min(page.width, Math.ceil(text.x + (3 * text.w) / 4)); x++) {
      total++;
      const inErase = x >= ex && x < ex + ew && y >= ey && y < ey + eh && erase.rgba[((y - ey) * ew + x - ex) * 4 + 3]! > 0;
      if (!inErase && Math.abs(gray[(y - top) * w + x - left]! - base) > INK_TOLERANCE) ink++;
    }
  return total > 0 ? ink / total : 0;
}

/** 整個文字框＋padding 的矩形；顏色從框外附近（TEXT_MARGIN 內）接近底色的像素內插，沒有就用單色底色。 */
function eraseRect(page: RgbaImage, text: Box): EraseImage {
  const { gray, left, top, w, h } = grayWindow(page, expandBox(text, TEXT_MARGIN));
  const clip = expandBox(text, ERASE_PADDING);
  const base = eraseLuminance({ gray, width: w, height: h }, { x: clip.x - left, y: clip.y - top, w: clip.w, h: clip.h });
  const bx = Math.max(0, Math.round(clip.x - left));
  const by = Math.max(0, Math.round(clip.y - top));
  const bw = Math.max(0, Math.min(w, Math.round(clip.x + clip.w - left)) - bx);
  const bh = Math.max(0, Math.min(h, Math.round(clip.y + clip.h - top)) - by);
  const inClip = (i: number) => i % w >= bx && i % w < bx + bw && Math.floor(i / w) >= by && Math.floor(i / w) < by + bh;
  const known = new Uint8Array(w * h);
  const wanted: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (inClip(i)) wanted.push(i);
    else if (Math.abs(gray[i]! - base) <= SEED_TOLERANCE) known[i] = 1;
  }
  const colors = interpolate(page, left, top, w, h, known, wanted, base);
  const rgba = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = (by + y) * w + bx + x;
      rgba.set([colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!, 255], (y * bw + x) * 4);
    }
  return { box: [left + bx, top + by, bw, bh], rgba };
}

/** 擦除範圍（alpha > 0）的平均亮度：Loose Text 的譯文用白字還是黑字（#151）。 */
export function meanLuminance({ rgba }: EraseImage): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    sum += luma(rgba, i);
    count++;
  }
  return count > 0 ? sum / count : 255;
}

/** box 夾在 Page 內的灰階視窗。 */
function grayWindow(page: RgbaImage, box: Box): { gray: Uint8Array; left: number; top: number; w: number; h: number } {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const w = Math.max(0, Math.min(page.width, Math.ceil(box.x + box.w)) - left);
  const h = Math.max(0, Math.min(page.height, Math.ceil(box.y + box.h)) - top);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      gray[y * w + x] = Math.round(luma(page.data, ((top + y) * page.width + left + x) * 4));
  return { gray, left, top, w, h };
}

/** 4 連通的 BFS：從 starts 出發，accept(from, to) 為真就走過去並 visit。 */
function flood(w: number, h: number, starts: number[], accept: (from: number, to: number) => boolean, visit: (i: number) => void): void {
  const queue = new Int32Array(w * h);
  const seen = new Uint8Array(w * h);
  let tail = 0;
  for (const s of starts) {
    if (seen[s]) continue;
    seen[s] = 1;
    visit(s);
    queue[tail++] = s;
  }
  const step = (p: number, n: number) => {
    if (seen[n] || !accept(p, n)) return;
    seen[n] = 1;
    visit(n);
    queue[tail++] = n;
  };
  for (let head = 0; head < tail; head++) {
    const p = queue[head]!;
    const x = p % w;
    if (x > 0) step(p, p - 1);
    if (x < w - 1) step(p, p + 1);
    if (p >= w) step(p, p - w);
    if (p + w < w * h) step(p, p + w);
  }
}

/**
 * 視窗內的 RGB：已知像素用原圖，wanted（要輸出的未知像素）從已知像素內插。用 push-pull 金字塔（每層 2×2 加權平均
 * 往上，再雙線性往下補洞），O(像素數)；最後在 wanted 上做幾輪鄰點平均。沒有已知像素時整塊用單色 base。
 */
function interpolate(page: RgbaImage, left: number, top: number, w: number, h: number, known: Uint8Array, wanted: number[], base: number): Float32Array {
  const n = w * h;
  // 第 0 層：已知像素權重 1
  const weight0 = new Float32Array(n);
  const color0 = new Float32Array(n * 3);
  let anyKnown = false;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!known[i]) continue;
      const p = ((top + y) * page.width + left + x) * 4;
      weight0[i] = 1;
      color0[i * 3] = page.data[p]!;
      color0[i * 3 + 1] = page.data[p + 1]!;
      color0[i * 3 + 2] = page.data[p + 2]!;
      anyKnown = true;
    }
  if (!anyKnown) return color0.fill(base);
  const levels: { w: number; h: number; weight: Float32Array; color: Float32Array }[] = [{ w, h, weight: weight0, color: color0 }];
  // push：每層 2×2 加權平均（color 是平均色，weight 夾在 1 以內）
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const prev = levels.at(-1)!;
    const lw = Math.ceil(prev.w / 2);
    const lh = Math.ceil(prev.h / 2);
    const weight = new Float32Array(lw * lh);
    const color = new Float32Array(lw * lh * 3);
    for (let y = 0; y < prev.h; y++)
      for (let x = 0; x < prev.w; x++) {
        const i = y * prev.w + x;
        const wt = prev.weight[i]!;
        if (wt === 0) continue;
        const j = (y >> 1) * lw + (x >> 1);
        weight[j]! += wt;
        color[j * 3]! += prev.color[i * 3]! * wt;
        color[j * 3 + 1]! += prev.color[i * 3 + 1]! * wt;
        color[j * 3 + 2]! += prev.color[i * 3 + 2]! * wt;
      }
    for (let j = 0; j < lw * lh; j++) {
      if (weight[j] === 0) continue;
      for (let c = 0; c < 3; c++) color[j * 3 + c]! /= weight[j]!;
      weight[j] = Math.min(1, weight[j]!);
    }
    levels.push({ w: lw, h: lh, weight, color });
  }
  // pull：從最粗的層往下，權重不滿 1 的像素用上一層雙線性補滿；第 0 層只補 wanted
  const fill = (fine: (typeof levels)[number], coarse: (typeof levels)[number], i: number) => {
    const wt = fine.weight[i]!;
    if (wt >= 1) return;
    const x = i % fine.w;
    const y = (i - x) / fine.w;
    const cx = Math.min(coarse.w - 1, Math.max(0, (x - 0.5) / 2));
    const cy = Math.min(coarse.h - 1, Math.max(0, (y - 0.5) / 2));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(coarse.w - 1, x0 + 1);
    const y1 = Math.min(coarse.h - 1, y0 + 1);
    const fx = cx - x0;
    const fy = cy - y0;
    const a = (y0 * coarse.w + x0) * 3;
    const b = (y0 * coarse.w + x1) * 3;
    const c = (y1 * coarse.w + x0) * 3;
    const d = (y1 * coarse.w + x1) * 3;
    for (let k = 0; k < 3; k++) {
      const up = (coarse.color[a + k]! * (1 - fx) + coarse.color[b + k]! * fx) * (1 - fy) + (coarse.color[c + k]! * (1 - fx) + coarse.color[d + k]! * fx) * fy;
      fine.color[i * 3 + k] = fine.color[i * 3 + k]! * wt + up * (1 - wt);
    }
    fine.weight[i] = 1;
  };
  for (let k = levels.length - 2; k >= 1; k--) for (let i = 0; i < levels[k]!.w * levels[k]!.h; i++) fill(levels[k]!, levels[k + 1]!, i);
  if (levels.length > 1) for (const i of wanted) fill(levels[0]!, levels[1]!, i);
  // 平滑只看有顏色的鄰居（已知或已內插）；框線、框外的像素在第 0 層沒有顏色。
  // 這是每頁最熱的迴圈（#151 量過），鄰居直接展開、不用 closure 與陣列
  const { color, weight } = levels[0]!;
  for (let sweep = 0; sweep < SMOOTHING_SWEEPS; sweep++)
    for (const i of wanted) {
      const x = i % w;
      let count = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < 4; k++) {
        // 左、右、上、下
        const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < w - 1 ? i + 1 : -1) : k === 2 ? (i >= w ? i - w : -1) : i + w < n ? i + w : -1;
        if (j < 0 || weight[j] === 0) continue;
        count++;
        r += color[j * 3]!;
        g += color[j * 3 + 1]!;
        b += color[j * 3 + 2]!;
      }
      if (count === 0) continue;
      color[i * 3] = r / count;
      color[i * 3 + 1] = g / count;
      color[i * 3 + 2] = b / count;
    }
  return color;
}
