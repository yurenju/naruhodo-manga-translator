import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../shared/pixels.ts';
import { readGroundTruth, readRgba, type GtBox } from '../testing/synthetic.ts';
import { eraseImage, eraseLooseText, largestRect, meanLuminance, type EraseImage } from './erase-image.ts';
import type { RecordedOcr } from './fake-engine.ts';

type Rgb = [number, number, number];

/** 畫一張頁：每個像素的顏色由 paint(x, y) 決定。 */
function page(width: number, height: number, paint: (x: number, y: number) => Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { data, width, height };
}

/** 橢圓泡泡（中心 cx, cy、半徑 rx, ry、框線 2px），框內 fill(x, y)，框外 outside。 */
function balloonPage(fill: (x: number, y: number) => Rgb, outside: Rgb = [120, 120, 120]) {
  const [cx, cy, rx, ry] = [50, 60, 40, 50];
  const d = (x: number, y: number) => Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
  const inside = (x: number, y: number) => d(x, y) < 1 - 2.5 / Math.min(rx, ry);
  const image = page(100, 120, (x, y) => {
    if (d(x, y) >= 1) return outside;
    if (!inside(x, y)) return [10, 10, 10];
    // 文字墨水：中間一個 30×40 的區塊裡每隔 4 列畫一條橫線
    if (x >= 35 && x < 65 && y >= 40 && y < 80 && y % 4 < 2) return [15, 15, 15];
    return fill(x, y);
  });
  return { image, inside, balloon: { x: 10, y: 10, w: 80, h: 100 } };
}

/** 文字框撐滿泡泡：四個角都在橢圓外。 */
const TEXT = { x: 20, y: 20, w: 60, h: 80 };

/** 把擦除小圖貼回頁上（alpha 0 的像素保留原圖）。 */
function composite(image: RgbaImage, erase: EraseImage): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  const [ex, ey, ew, eh] = erase.box;
  for (let y = 0; y < eh; y++)
    for (let x = 0; x < ew; x++) {
      const src = (y * ew + x) * 4;
      if (erase.rgba[src + 3] === 0) continue;
      data.set(erase.rgba.subarray(src, src + 3), ((ey + y) * image.width + ex + x) * 4);
    }
  return { ...image, data };
}

/** 擦除範圍（alpha > 0）的像素座標。 */
function erased(erase: EraseImage): [number, number][] {
  const [ex, ey, ew, eh] = erase.box;
  const out: [number, number][] = [];
  for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) if (erase.rgba[(y * ew + x) * 4 + 3]! > 0) out.push([ex + x, ey + y]);
  return out;
}

const pixel = ({ data, width }: RgbaImage, x: number, y: number): Rgb => [data[(y * width + x) * 4]!, data[(y * width + x) * 4 + 1]!, data[(y * width + x) * 4 + 2]!];

describe('eraseImage（擦除範圍沿泡泡內緣，顏色從背景內插）', () => {
  it('文字框的角在泡泡外：擦除範圍不出泡泡框線，框內的字擦乾淨、底色是白的', () => {
    const { image, inside, balloon } = balloonPage(() => [255, 255, 255]);

    const erase = eraseImage(image, balloon, TEXT)!;

    expect(erase).toBeDefined();
    for (const [x, y] of erased(erase)) expect(inside(x, y), `(${x}, ${y}) 在泡泡框線上或外面`).toBe(true);
    const result = composite(image, erase);
    for (let y = TEXT.y; y < TEXT.y + TEXT.h; y++)
      for (let x = TEXT.x; x < TEXT.x + TEXT.w; x++) if (inside(x, y)) expect(pixel(result, x, y), `(${x}, ${y})`).toEqual([255, 255, 255]);
  });

  it('漸層泡泡：擦掉的字用周圍背景內插，接得上漸層，不被墨水和框線染灰', () => {
    // 上白下藍的漸層：每列的顏色只跟 y 有關
    const gradient = (_: number, y: number): Rgb => [255 - y, 255 - Math.round(y / 2), 255];
    const { image, inside, balloon } = balloonPage(gradient);

    const result = composite(image, eraseImage(image, balloon, TEXT)!);

    for (let y = TEXT.y; y < TEXT.y + TEXT.h; y++)
      for (let x = TEXT.x; x < TEXT.x + TEXT.w; x++) {
        if (!inside(x, y)) continue;
        const [r, g, b] = pixel(result, x, y);
        const [er, eg, eb] = gradient(x, y);
        expect(Math.max(Math.abs(r - er), Math.abs(g - eg), Math.abs(b - eb)), `(${x}, ${y})`).toBeLessThanOrEqual(4);
      }
  });

  it('排版矩形（#150）整塊落在擦除範圍內：橢圓泡泡裡是泡泡內緣的內接矩形，不是文字框', () => {
    const { image, inside, balloon } = balloonPage(() => [255, 255, 255]);

    const erase = eraseImage(image, balloon, TEXT)!;

    const done = new Set(erased(erase).map(([x, y]) => `${x},${y}`));
    const [fx, fy, fw, fh] = erase.fit;
    for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) expect(done.has(`${x},${y}`), `(${x}, ${y}) 不在擦除範圍內`).toBe(true);
    // 擦除範圍是橢圓內緣（半徑約 37.5×47.5）跟文字框＋3px 的交集，內接矩形約 53×67
    expect(fw * fh).toBeGreaterThan(0.9 * 53 * 67);
    expect(inside(fx, fy) && inside(fx + fw - 1, fy + fh - 1)).toBe(true);
  });

  it('文字框中央完全找不到接近底色的像素：回傳 undefined（呼叫端退回矩形）', () => {
    // 白底，文字框 10～30，中央一半（15～25）整塊是黑的
    const image = page(40, 40, (x, y) => (x >= 15 && x < 25 && y >= 15 && y < 25 ? [0, 0, 0] : [255, 255, 255]));
    const text = { x: 10, y: 10, w: 20, h: 20 };

    expect(eraseImage(image, { x: 0, y: 0, w: 40, h: 40 }, text)).toBeUndefined();
  });
});

/** 擦除範圍都在文字框外擴 3px 之內。 */
function expectWithinPadding(erase: EraseImage, text: { x: number; y: number; w: number; h: number }): void {
  for (const [x, y] of erased(erase))
    expect(x >= text.x - 3 && x < text.x + text.w + 3 && y >= text.y - 3 && y < text.y + text.h + 3, `(${x}, ${y}) 在文字框＋padding 外`).toBe(true);
}

describe('eraseLooseText（Loose Text：範圍限制在文字框＋padding，殘留太多就退回矩形）', () => {
  // 文字框 30～70：裡面 4 個不相連的墨水方塊（字）
  const TEXT_BOX = { x: 30, y: 30, w: 40, h: 40 };
  const glyph = (x: number, y: number) => [34, 54].some((gx) => x >= gx && x < gx + 12) && [34, 54].some((gy) => y >= gy && y < gy + 12);

  it('白底上的字：沿字的周圍擦，範圍不出文字框＋padding，字擦乾淨', () => {
    const image = page(100, 100, (x, y) => (glyph(x, y) ? [0, 0, 0] : [255, 255, 255]));

    const erase = eraseLooseText(image, TEXT_BOX);

    expectWithinPadding(erase, TEXT_BOX);
    const result = composite(image, erase);
    for (let y = TEXT_BOX.y; y < TEXT_BOX.y + TEXT_BOX.h; y++)
      for (let x = TEXT_BOX.x; x < TEXT_BOX.x + TEXT_BOX.w; x++) expect(pixel(result, x, y), `(${x}, ${y})`).toEqual([255, 255, 255]);
  });

  it('字黏在穿過文字框的線條上（沿字擦不掉）：退回整個文字框＋padding 的矩形，顏色從框外的背景內插', () => {
    // 一條橫線穿過整張圖，四個字都碰到它
    const line = (y: number) => y >= 44 && y < 56;
    const image = page(100, 100, (x, y) => (glyph(x, y) || (line(y) && (x < 34 || x >= 66 || (x >= 46 && x < 54))) ? [0, 0, 0] : [250, 200, 120]));

    const erase = eraseLooseText(image, TEXT_BOX);

    expect(erase.box).toEqual([27, 27, 46, 46]);
    expect(erased(erase)).toHaveLength(46 * 46);
    const result = composite(image, erase);
    for (let y = TEXT_BOX.y; y < TEXT_BOX.y + TEXT_BOX.h; y++)
      for (let x = TEXT_BOX.x; x < TEXT_BOX.x + TEXT_BOX.w; x++) {
        const [r, g, b] = pixel(result, x, y);
        expect(Math.max(Math.abs(r - 250), Math.abs(g - 200), Math.abs(b - 120)), `(${x}, ${y}) 沒擦成背景色`).toBeLessThanOrEqual(8);
      }
  });

  it('細線穿過文字框但沒碰到字：沿字擦，線條保留下來', () => {
    // 文字框 20～80；2px 橫線在 y＝49～50，字在線的上下、不碰線
    const text = { x: 20, y: 20, w: 60, h: 60 };
    const ink = (x: number, y: number) => [26, 56].some((gx) => x >= gx && x < gx + 18) && [26, 56].some((gy) => y >= gy && y < gy + 18);
    const image = page(100, 100, (x, y) => (ink(x, y) || y === 49 || y === 50 ? [0, 0, 0] : [255, 255, 255]));

    const result = composite(image, eraseLooseText(image, text));

    for (let x = 0; x < 100; x++) expect(pixel(result, x, 49), `(${x}, 49)`).toEqual([0, 0, 0]);
    for (const [x, y] of [[30, 30], [60, 30], [30, 60], [60, 60]] as const) expect(pixel(result, x, y), `(${x}, ${y})`).toEqual([255, 255, 255]);
  });

  it('文字框中央整塊都是墨水（找不到底色的起點）：同樣退回矩形，不會沒有小圖', () => {
    const image = page(100, 100, (x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? [0, 0, 0] : [255, 255, 255]));

    const erase = eraseLooseText(image, TEXT_BOX);

    expect(erased(erase)).toHaveLength(46 * 46);
    expect(meanLuminance(erase)).toBeGreaterThan(250);
  });

  it('meanLuminance：擦除範圍（alpha > 0）的平均亮度，黑底白字是暗的（譯文用白字）', () => {
    const image = page(100, 100, (x, y) => (glyph(x, y) ? [255, 255, 255] : [10, 10, 10]));

    expect(meanLuminance(eraseLooseText(image, TEXT_BOX))).toBeLessThan(128);
  });
});

describe('largestRect（範圍內面積最大的軸對齊矩形）', () => {
  /** 用字元畫 mask：# 是範圍內。 */
  const mask = (rows: string[]) => ({ mask: Uint8Array.from(rows.join(''), (c) => (c === '#' ? 1 : 0)), w: rows[0]!.length, h: rows.length });

  it('整塊都是範圍：就是整塊', () => {
    const { mask: m, w, h } = mask(['#####', '#####', '#####']);
    expect(largestRect(m, w, h)).toEqual([0, 0, 5, 3]);
  });

  it('不規則形狀：L 形加一個洞，取面積最大的那塊', () => {
    const { mask: m, w, h } = mask([
      '##......',
      '##......',
      '########',
      '###.####',
      '########',
    ]);
    // 洞右邊的 4×3＝12，比左邊兩欄 2×5＝10、洞左邊的 3×3、整列 8×1 都大
    expect(largestRect(m, w, h)).toEqual([4, 2, 4, 3]);
  });

  it('沒有範圍：寬高為 0', () => {
    const { mask: m, w, h } = mask(['...', '...']);
    const [, , rw, rh] = largestRect(m, w, h);
    expect(rw * rh).toBe(0);
  });

  it('橢圓：矩形在橢圓內，面積接近內接矩形的理論最大值 2ab（外框的 √½ × √½）', () => {
    const [w, h, a, b] = [200, 120, 100, 60];
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) m[y * w + x] = Math.hypot((x + 0.5 - a) / a, (y + 0.5 - b) / b) < 1 ? 1 : 0;

    const [rx, ry, rw, rh] = largestRect(m, w, h);

    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) expect(m[y * w + x], `(${x}, ${y})`).toBe(1);
    expect(rw * rh).toBeGreaterThan(0.97 * 2 * a * b);
  });
});

describe('eraseImage：合成頁 p09（真模型錄下的框）', () => {
  const id = 'p09-erase';
  const image = readRgba(id);
  // 同一頁不畫字：完美擦除後應該長的樣子
  const blank = readRgba(`${id}-blank`);
  const gt = readGroundTruth(id);
  const recorded = (JSON.parse(readFileSync(new URL('../../testdata/synthetic/recorded-ocr.json', import.meta.url), 'utf8')) as RecordedOcr[]).find(
    (r) => r.id === id,
  )!;
  const px = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * image.width, y: r.y * image.height, w: r.w * image.width, h: r.h * image.height });
  /** 像素中心在泡泡的橢圓裡（ground truth 的外框）；inset 是往內縮幾 px，負的是往外。 */
  const insideBalloon = ([bx, by, bw, bh]: GtBox, x: number, y: number, inset: number) =>
    Math.hypot((x + 0.5 - bx - bw / 2) / (bw / 2 - inset), (y + 0.5 - by - bh / 2) / (bh / 2 - inset)) < 1;
  /** 泡泡尾巴：spec 的 tail 尖端，跟橢圓 0.92 倍處左右各 0.18 弧度的兩點連成三角形（同 template.js 的 tailPath）。 */
  const spec = JSON.parse(readFileSync(new URL(`../../testdata/synthetic/specs/${id}.json`, import.meta.url), 'utf8')) as {
    texts: { cx: number; cy: number; w: number; h: number; tail?: [number, number] }[];
  };
  const tails = spec.texts.flatMap(({ cx, cy, w, h, tail }) => {
    if (!tail) return [];
    const angle = Math.atan2(tail[1] - cy, tail[0] - cx);
    const at = (a: number): [number, number] => [cx + Math.cos(a) * (w / 2) * 0.92, cy + Math.sin(a) * (h / 2) * 0.92];
    return [[at(angle - 0.18), tail, at(angle + 0.18)] as [number, number][]];
  });
  /** 像素中心在三角形裡，或離三角形的邊 1.5px（框線外緣）以內。 */
  const insideTail = (tri: [number, number][], x: number, y: number) => {
    const [px0, py0] = [x + 0.5, y + 0.5];
    const cross = ([ax, ay]: [number, number], [bx, by]: [number, number]) => (bx - ax) * (py0 - ay) - (by - ay) * (px0 - ax);
    const signs = tri.map((a, i) => Math.sign(cross(a, tri[(i + 1) % 3]!)));
    if (signs.every((s) => s >= 0) || signs.every((s) => s <= 0)) return true;
    return tri.some(([ax, ay], i) => {
      const [bx, by] = tri[(i + 1) % 3]!;
      const t = Math.max(0, Math.min(1, ((px0 - ax) * (bx - ax) + (py0 - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      return Math.hypot(px0 - ax - t * (bx - ax), py0 - ay - t * (by - ay)) <= 1.5;
    });
  };
  const overlap = (a: GtBox, b: { x: number; y: number; w: number; h: number }) =>
    Math.max(0, Math.min(a[0] + a[2], b.x + b.w) - Math.max(a[0], b.x)) * Math.max(0, Math.min(a[1] + a[3], b.y + b.h) - Math.max(a[1], b.y));
  const diff = (a: RgbaImage, b: RgbaImage, x: number, y: number) => Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[(y * a.width + x) * 4 + c]! - b.data[(y * b.width + x) * 4 + c]!)));

  for (const balloon of recorded.balloons) {
    const text = px(balloon.textBbox);
    const truth = gt.texts.reduce((best, t) => (overlap(t.textBbox, text) > overlap(best.textBbox, text) ? t : best));

    it(`${truth.id}（${truth.shape}）：擦除範圍不出泡泡框線；貼回後框線、接縫、框外都跟沒有字的頁一樣，文字框內沒有殘留墨水`, () => {
      const erase = eraseImage(image, px(balloon.balloonBbox), text);

      expect(erase, '退回了矩形').toBeDefined();
      // 框線 3px：擦除範圍不超出框線外緣（1.5px）。連體泡泡可以在相連的兩個泡泡裡。閃光泡泡沒有外框，
      // 放射線之間的白底本來就跟泡泡相連，只看下面的「放射線沒被改」
      const balloons = gt.texts.filter((t) => t.shape !== 'flash').map((t) => t.bbox);
      if (truth.shape !== 'flash')
        for (const [x, y] of erased(erase!))
          expect(balloons.some((b) => insideBalloon(b, x, y, -1.5)) || tails.some((t) => insideTail(t, x, y)), `(${x}, ${y}) 在泡泡框線外`).toBe(true);
      const result = composite(image, erase!);
      const [tx, ty, tw, th] = truth.textBbox;
      let residue = 0;
      let total = 0;
      for (let y = ty - 6; y < ty + th + 6; y++)
        for (let x = tx - 6; x < tx + tw + 6; x++) {
          const d = diff(result, blank, x, y);
          if (!insideBalloon(truth.bbox, x, y, 3)) expect(d, `(${x}, ${y}) 框線或框外被改了`).toBeLessThanOrEqual(8);
          else {
            total++;
            if (d > 32) residue++;
          }
        }
      expect(residue / total, `殘留墨水 ${residue} / ${total} 像素`).toBeLessThan(0.002);
    });
  }
});

describe('eraseLooseText：合成頁 p09 的 Loose Text（真模型錄下的框）', () => {
  const id = 'p09-erase';
  const image = readRgba(id);
  const blank = readRgba(`${id}-blank`);
  const gt = readGroundTruth(id);
  const recorded = (JSON.parse(readFileSync(new URL('../../testdata/synthetic/recorded-ocr.json', import.meta.url), 'utf8')) as RecordedOcr[]).find(
    (r) => r.id === id,
  )!;
  const px = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * image.width, y: r.y * image.height, w: r.w * image.width, h: r.h * image.height });
  const overlap = (a: GtBox, b: { x: number; y: number; w: number; h: number }) =>
    Math.max(0, Math.min(a[0] + a[2], b.x + b.w) - Math.max(a[0], b.x)) * Math.max(0, Math.min(a[1] + a[3], b.y + b.h) - Math.max(a[1], b.y));
  const diff = (a: RgbaImage, b: RgbaImage, x: number, y: number) => Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[(y * a.width + x) * 4 + c]! - b.data[(y * b.width + x) * 4 + c]!)));
  /** box 裡沒被擦除小圖蓋到的像素（y × 頁寬 + x）。 */
  const unerased = (erase: EraseImage, [bx, by, bw, bh]: GtBox) => {
    const covered = new Set(erased(erase).map(([x, y]) => y * image.width + x));
    const out: number[] = [];
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) if (!covered.has(y * image.width + x)) out.push(y * image.width + x);
    return out;
  };

  it('錄到的 Loose Text 正是合成頁的 5 段（白描邊獨白、黑底白字、網點上的標題、彩色背景、狀聲詞）', () => {
    const matched = recorded.looseText.map((l) => gt.texts.reduce((best, t) => (overlap(t.textBbox, px(l.bbox)) > overlap(best.textBbox, px(l.bbox)) ? t : best)).id);
    expect(matched.sort()).toEqual(['t10', 't11', 't12', 't8', 't9']);
  });

  for (const loose of recorded.looseText) {
    const text = px(loose.bbox);
    const truth = gt.texts.reduce((best, t) => (overlap(t.textBbox, text) > overlap(best.textBbox, text) ? t : best));

    it(`${truth.id}（${truth.ja}）：擦除範圍不超出文字框＋padding，文字框內沒有殘留原文墨水`, () => {
      const erase = eraseLooseText(image, text);

      expectWithinPadding(erase, { x: Math.floor(text.x), y: Math.floor(text.y), w: Math.ceil(text.w) + 1, h: Math.ceil(text.h) + 1 });
      // 殘留＝原文的墨水（有字的頁跟沒字的頁不一樣的像素）沒被小圖蓋到。白描邊獨白跟線條交會處的反鋸齒會留下一點點
      const kept = new Set(unerased(erase, truth.textBbox));
      const [tx, ty, tw, th] = truth.textBbox;
      let residue = 0;
      for (let y = ty; y < ty + th; y++) for (let x = tx; x < tx + tw; x++) if (diff(image, blank, x, y) > 32 && kept.has(y * image.width + x)) residue++;
      expect(residue / (tw * th), `殘留墨水 ${residue} / ${tw * th} 像素`).toBeLessThan(0.01);
    });
  }
});
