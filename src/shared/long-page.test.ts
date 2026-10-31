import { describe, expect, it } from 'vitest';
import { resize, type GrayImage } from '../testing/image-degrade.ts';
import { cropGray, readGray } from '../testing/synthetic.ts';
import { addLines, matchingStripe, rejectInSlice, sameLongPage, sliceOf, stripeFingerprint, toPageBox, toPageText } from './long-page.ts';
import type { BalloonText, LooseText, PageText, RatioRect } from './page-text.ts';

/** 合成頁上下接成一張長圖（像直式捲動漫畫那樣，接縫看不出來）。 */
function stack(...ids: string[]): GrayImage {
  const parts = ids.map((id) => readGray(id));
  const width = parts[0]!.width;
  const height = parts.reduce((sum, p) => sum + p.height, 0);
  const gray = new Uint8Array(width * height);
  let offset = 0;
  for (const p of parts) {
    gray.set(p.gray, offset);
    offset += p.gray.length;
  }
  return { gray, width, height };
}

const scale = (image: GrayImage, s: number) => resize(image, Math.round(image.width * s), Math.round(image.height * s));

/** 長 Page 縮放成 s 倍顯示，看得到 Page 座標 top～bottom（0～1）這一截：截到的圖與它在 Page 裡從第幾個像素開始。 */
function shownSlice(page: GrayImage, s: number, top: number, bottom: number): { image: GrayImage; offset: number } {
  const shown = scale(page, s);
  const y = Math.round(top * shown.height);
  return { image: cropGray(shown, [0, y, shown.width, Math.round(bottom * shown.height) - y]), offset: y };
}

describe('長 Page 的橫條指紋', () => {
  const longPage = stack('p01-basic', 'p02-ruby', 'p03-shapes');

  it('依 Page 寬度切成高度是寬度 1/4 的橫條，只算完整看得到的橫條', () => {
    // 880 寬 → 橫條高 220；Page 第 300～1500 px：完整的是第 2～5 條（440～1320）
    const { image, offset } = shownSlice(longPage, 1, 300 / 3840, 1500 / 3840);
    expect(stripeFingerprint(image, offset).map((s) => s.index)).toEqual([2, 3, 4, 5]);
  });

  it('跟自己的覆蓋層有交集的橫條不算（蓋著中文的 hash 跟原稿對不上）', () => {
    // 同上：完整的是第 2～5 條（440～1320）；覆蓋層在 Page 第 700～750 px（第 3 條）與 1310～1400 px（擦過第 5 條的底）
    const { image, offset } = shownSlice(longPage, 1, 300 / 3840, 1500 / 3840);
    const covered = [
      { top: 700, bottom: 750 },
      { top: 1310, bottom: 1400 },
    ];
    expect(stripeFingerprint(image, offset, covered).map((s) => s.index)).toEqual([2, 4]);
  });

  it('改變縮放後仍對得上（同一條橫條的 hash 在門檻內）', () => {
    const before = shownSlice(longPage, 0.49, 0.1, 0.4);
    const after = shownSlice(longPage, 0.75, 0.2, 0.5);
    const a = stripeFingerprint(before.image, before.offset);
    const b = stripeFingerprint(after.image, after.offset);
    expect(a.some((s) => b.some((t) => t.index === s.index))).toBe(true);
    expect(sameLongPage(a, b)).toBe(true);
  });

  it('不同的長 Page 對不上', () => {
    const other = stack('p04-outside', 'p05-dense', 'p06-horizontal');
    const a = shownSlice(longPage, 0.49, 0.1, 0.5);
    const b = shownSlice(other, 0.49, 0.1, 0.5);
    expect(sameLongPage(stripeFingerprint(a.image, a.offset), stripeFingerprint(b.image, b.offset))).toBe(false);
  });

  it('同一個 hash 在不同條的位置不算對上', () => {
    const { image, offset } = shownSlice(longPage, 1, 0, 0.3);
    const stripes = stripeFingerprint(image, offset);
    expect(sameLongPage(stripes, stripes.map((s) => ({ ...s, index: s.index + 1 })))).toBe(false);
  });

  it('matchingStripe 回傳對上的是第幾條（trace 用），對不上是 undefined', () => {
    const known = [{ index: 0, hash: '0'.repeat(64) }, { index: 3, hash: 'f'.repeat(64) }];
    expect(matchingStripe(known, [{ index: 3, hash: 'f'.repeat(64) }, { index: 4, hash: '0'.repeat(64) }])).toBe(3);
    expect(matchingStripe(known, [{ index: 1, hash: '0'.repeat(64) }])).toBeUndefined();
  });

  it('沒有內容的橫條（空白）不算', () => {
    const blank: GrayImage = { gray: new Uint8Array(880 * 1000).fill(255), width: 880, height: 1000 };
    expect(stripeFingerprint(blank, 0)).toEqual([]);
  });
});

describe('一截裡哪些框要收', () => {
  /** Page 的 30%～60% 這一截，截圖 1000 px 高。 */
  const slice = { top: 0.3, bottom: 0.6 };
  const reject = (box: RatioRect, collected: RatioRect[] = [], at = slice) => rejectInSlice(box, at, 1000, collected);

  it('完整在這一截裡、沒跟已收 Line 重疊的框收進來', () => {
    expect(reject({ x: 0.1, y: 0.2, w: 0.2, h: 0.3 })).toBeUndefined();
  });

  it('被這一截的上緣或下緣切到的框先不收', () => {
    expect(reject({ x: 0.1, y: 0, w: 0.2, h: 0.3 })).toBe('cut');
    expect(reject({ x: 0.1, y: 0.7, w: 0.2, h: 0.3 })).toBe('cut');
    // 離邊緣 1 px 也算切到（偵測框貼著截圖邊）
    expect(reject({ x: 0.1, y: 0.7, w: 0.2, h: 0.299 })).toBe('cut');
  });

  it('貼著 Page 本身的上下緣不算切到', () => {
    expect(reject({ x: 0.1, y: 0, w: 0.2, h: 0.3 }, [], { top: 0, bottom: 0.3 })).toBeUndefined();
    expect(reject({ x: 0.1, y: 0.7, w: 0.2, h: 0.3 }, [], { top: 0.7, bottom: 1 })).toBeUndefined();
  });

  it('上下都被切到＝比可見範圍還高，永遠收不到', () => {
    expect(reject({ x: 0.1, y: 0, w: 0.2, h: 1 })).toBe('tooTall');
  });

  it('跟已收 Line 在 Page 座標上重疊的框丟掉', () => {
    // 這一截的 y 0.2～0.5 ＝ Page 的 0.36～0.45
    const box = { x: 0.1, y: 0.2, w: 0.2, h: 0.3 };
    expect(reject(box, [{ x: 0.25, y: 0.44, w: 0.2, h: 0.1 }])).toBe('overlap');
    // 只是左右或上下相鄰，沒有重疊
    expect(reject(box, [{ x: 0.3, y: 0.36, w: 0.2, h: 0.09 }])).toBeUndefined();
    expect(reject(box, [{ x: 0.1, y: 0.45, w: 0.2, h: 0.1 }])).toBeUndefined();
  });
});

describe('一截的座標換成 Page 座標', () => {
  it('x 不變，y 依這一截在 Page 裡的範圍換算', () => {
    const box = toPageBox({ x: 0.1, y: 0.5, w: 0.2, h: 0.5 }, { top: 0.2, bottom: 0.6 });
    expect(box.x).toBeCloseTo(0.1);
    expect(box.y).toBeCloseTo(0.4);
    expect(box.w).toBeCloseTo(0.2);
    expect(box.h).toBeCloseTo(0.2);
  });
});

describe('新收的 Line 併進長 Page', () => {
  const balloon = (id: string, order: number, y: number, h: number, 原文 = id): BalloonText => ({
    id,
    order,
    balloonBbox: { x: 0.1, y, w: 0.2, h },
    textBbox: { x: 0.1, y, w: 0.2, h },
    orientation: 'vertical',
    原文,
    讀音: '',
    讀音來源: 'kuromoji',
    譯文: '',
    unreadable: false,
  });
  const loose = (id: string, order: number, y: number, h: number, 原文 = id): LooseText => ({
    id,
    order,
    bbox: { x: 0.5, y, w: 0.1, h },
    orientation: 'vertical',
    原文,
    讀音: '',
    讀音來源: 'kuromoji',
    譯文: '',
    unreadable: false,
  });
  /** 依 order 列出原文。 */
  const reading = ({ balloons, looseText }: PageText) => [...balloons, ...looseText].sort((a, b) => a.order - b.order).map((t) => t.原文);

  it('依框中心的 y 由上到下排；同一次截圖裡上下重疊的框照偵測器的閱讀順序', () => {
    const added: PageText = {
      // 同一列的兩個 Balloon（右邊先讀），右邊的稍微低一點
      balloons: [balloon('b1', 1, 0.1, 0.1, '右'), balloon('b2', 2, 0.05, 0.1, '左')],
      looseText: [loose('l1', 3, 0.01, 0.02, '最上面')],
    };
    expect(reading(addLines({ balloons: [], looseText: [] }, added))).toEqual(['最上面', '右', '左']);
  });

  it('接在已收 Line 之間的正確位置，已收 Line 的順序不變', () => {
    const existing: PageText = { balloons: [balloon('b1', 1, 0.1, 0.05, '上'), balloon('b2', 2, 0.5, 0.05, '下')], looseText: [] };
    const merged = addLines(existing, { balloons: [balloon('b1', 1, 0.3, 0.05, '中')], looseText: [] });
    expect(reading(merged)).toEqual(['上', '中', '下']);
  });

  it('id 接著已收 Line 編號，同一個 Page 裡不重複', () => {
    const existing: PageText = { balloons: [balloon('b1', 1, 0.1, 0.05), balloon('b2', 2, 0.2, 0.05)], looseText: [loose('l1', 3, 0.3, 0.05)] };
    const merged = addLines(existing, { balloons: [balloon('b1', 1, 0.6, 0.05)], looseText: [loose('l1', 2, 0.7, 0.05)] });
    expect(merged.balloons.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(merged.looseText.map((l) => l.id)).toEqual(['l1', 'l2']);
  });
});

describe('看得到的那一截在 Page 裡的範圍', () => {
  it('從 anchor rect 與看得到的 rect（CSS px）算出 Page 高度的比例', () => {
    expect(sliceOf({ x: 440, y: -600, width: 400, height: 2400 }, { x: 440, y: 60, width: 400, height: 600 })).toEqual({ top: 0.275, bottom: 0.525 });
  });
});

describe('toPageText（一截的結果換成 Page 座標）', () => {
  it('擦除小圖的位置跟文字框一起換算（#149），小圖本身不動', () => {
    const balloon: BalloonText = {
      id: 'b1',
      order: 1,
      balloonBbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 },
      textBbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.2 },
      orientation: 'vertical',
      原文: 'パン',
      讀音: 'ぱん',
      讀音來源: 'kuromoji',
      譯文: '',
      unreadable: false,
      erase: { box: { x: 0.18, y: 0.28, w: 0.24, h: 0.24 }, image: 'data:image/png;base64,AAAA', fit: { x: 0.2, y: 0.32, w: 0.2, h: 0.16 } },
    };

    // 這一截是 Page 的 50%～75%
    const [onPage] = toPageText({ balloons: [balloon], looseText: [] }, { top: 0.5, bottom: 0.75 }).balloons;

    const close = (actual: RatioRect, expected: RatioRect) => {
      for (const key of ['x', 'y', 'w', 'h'] as const) expect(actual[key], key).toBeCloseTo(expected[key]);
    };
    close(onPage!.textBbox, { x: 0.2, y: 0.575, w: 0.2, h: 0.05 });
    close(onPage!.erase!.box, { x: 0.18, y: 0.57, w: 0.24, h: 0.06 });
    close(onPage!.erase!.fit!, { x: 0.2, y: 0.58, w: 0.2, h: 0.04 });
    expect(onPage!.erase!.image).toBe('data:image/png;base64,AAAA');
  });

  it('Loose Text 的擦除小圖也跟文字框一起換算（#151）', () => {
    const loose: LooseText = {
      id: 'l1',
      order: 1,
      bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.2 },
      orientation: 'vertical',
      原文: 'あ…',
      讀音: 'あ…',
      讀音來源: 'kuromoji',
      譯文: '',
      unreadable: false,
      erase: { box: { x: 0.18, y: 0.28, w: 0.24, h: 0.24 }, image: 'data:image/png;base64,AAAA' },
    };

    const [onPage] = toPageText({ balloons: [], looseText: [loose] }, { top: 0.5, bottom: 0.75 }).looseText;

    expect(onPage!.erase!.box.y).toBeCloseTo(0.57);
    expect(onPage!.erase!.box.h).toBeCloseTo(0.06);
    expect(onPage!.erase!.image).toBe('data:image/png;base64,AAAA');
  });
});
