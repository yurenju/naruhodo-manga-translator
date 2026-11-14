import { describe, expect, it } from 'vitest';
import type { LineBox, PageView } from './messages.ts';
import { onAnchor, pageOutlines, staggerRanks, translatingLines, washArea } from './page-outlines.ts';
import type { BalloonText, LooseText } from './page-text.ts';

const balloon = (id: string, order: number, overrides: Partial<BalloonText> = {}): BalloonText => ({
  id,
  order,
  balloonBbox: { x: 0.1, y: 0.1 * order, w: 0.2, h: 0.05 },
  textBbox: { x: 0.12, y: 0.1 * order, w: 0.1, h: 0.04 },
  orientation: 'vertical',
  原文: 'あ',
  讀音: 'あ',
  讀音來源: 'kuromoji',
  譯文: '',
  unreadable: false,
  ...overrides,
});

const loose = (id: string, order: number, overrides: Partial<LooseText> = {}): LooseText => ({
  id,
  order,
  bbox: { x: 0.5, y: 0.1 * order, w: 0.2, h: 0.05 },
  orientation: 'horizontal',
  原文: 'ドン',
  讀音: 'どん',
  讀音來源: 'kuromoji',
  譯文: '',
  unreadable: false,
  ...overrides,
});

describe('送去翻譯的句子的外框（#285）', () => {
  it('Balloon 用泡泡外框、Loose Text 用文字框，兩種共用同一串閱讀順序', () => {
    const lines = translatingLines({ balloons: [balloon('b1', 1), balloon('b2', 3)], looseText: [loose('l1', 2)] });

    expect(lines.map((l) => [l.id, l.kind, l.order])).toEqual([
      ['b1', 'balloon', 1],
      ['l1', 'loose', 2],
      ['b2', 'balloon', 3],
    ]);
    expect(lines[0]!.box).toEqual(balloon('b1', 1).balloonBbox);
    expect(lines[1]!.box).toEqual(loose('l1', 2).bbox);
  });

  it('本機已經判成 unreadable 的句子不畫：它不會被覆蓋，外圈會讓人以為等一下有譯文', () => {
    const lines = translatingLines({ balloons: [balloon('b1', 1, { unreadable: true }), balloon('b2', 2)], looseText: [loose('l1', 3, { unreadable: true })] });

    expect(lines.map((l) => l.id)).toEqual(['b2']);
  });

  it('帶上文字框與擦除底色：底色掃光蓋在日文上、用擦除的顏色', () => {
    const lines = translatingLines({ balloons: [balloon('b1', 1, { eraseLuminance: 12 })], looseText: [loose('l1', 2, { eraseLuminance: 250 })] });

    expect(lines[0]).toMatchObject({ textBox: balloon('b1', 1).textBbox, eraseLuminance: 12 });
    expect(lines[1]).toMatchObject({ textBox: loose('l1', 2).bbox, eraseLuminance: 250 });
  });

  it('沒有擦除底色（舊快取）當白底，跟擦除一樣', () => {
    const [line] = translatingLines({ balloons: [balloon('b1', 1)], looseText: [] });

    expect(line!.eraseLuminance).toBe(255);
  });
});

describe('底色掃光的範圍', () => {
  it('就是文字框，換成外圈（泡泡外框）的比例：不照比例往外擴，直長的文字框才不會擴出泡泡', () => {
    const box = { x: 0.1, y: 0.2, w: 0.4, h: 0.4 };
    const text = { x: 0.2, y: 0.3, w: 0.2, h: 0.2 };

    const area = washArea(box, text);

    expect(area.x).toBeCloseTo(0.25);
    expect(area.y).toBeCloseTo(0.25);
    expect(area.w).toBeCloseTo(0.5);
    expect(area.h).toBeCloseTo(0.5);
  });

  it('Loose Text 的外圈就是文字框：範圍就是整個外圈', () => {
    const text = { x: 0.2, y: 0.3, w: 0.2, h: 0.1 };

    expect(washArea(text, text)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('這個 tab 要畫外圈的 Page', () => {
  const line = (id: string): LineBox => ({ id, kind: 'balloon', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, order: 1 });
  const page = (anchorId: string, extra: Partial<PageView> = {}): PageView => ({
    anchorId,
    rect: { x: 0, y: 0, width: 400, height: 600 },
    thumbnail: 'data:',
    pageHash: anchorId,
    transcript: { state: 'analyzing' },
    ...extra,
  });

  it('只列有外圈的 Page，帶上它在 anchor 裡的範圍（Spread 的一頁）', () => {
    const sub = { x: 0.5, y: 0, w: 0.5, h: 1 };
    const outlines = pageOutlines([page('a1'), page('a2', { subRect: sub, translatingLines: [line('b1')] }), page('a3', { waitingLines: [line('w1')] })]);

    expect(outlines).toEqual([
      { anchorId: 'a2', pageHash: 'a2', subRect: sub, translating: [line('b1')], waiting: [] },
      { anchorId: 'a3', pageHash: 'a3', translating: [], waiting: [line('w1')] },
    ]);
  });
});

describe('照閱讀順序錯開', () => {
  it('每一句排第幾個只看閱讀順序，跟傳進來的順序、編號有沒有跳號無關', () => {
    const ranks = staggerRanks([
      { id: 'b7', order: 9 },
      { id: 'l1', order: 2 },
      { id: 'b3', order: 5 },
    ]);

    expect([...ranks]).toEqual([
      ['l1', 0],
      ['b3', 1],
      ['b7', 2],
    ]);
  });
});

describe('外框在 anchor 上的位置', () => {
  it('Spread 的左頁：Page 座標換成 anchor 的比例', () => {
    expect(onAnchor({ x: 0.5, y: 0.2, w: 0.2, h: 0.1 }, { x: 0, y: 0, w: 0.5, h: 1 })).toEqual({ x: 0.25, y: 0.2, w: 0.1, h: 0.1 });
  });

  it('直式排版的一串裡跨過元素交界的框可以超出 0～1', () => {
    const box = onAnchor({ x: 0.1, y: 0.95, w: 0.3, h: 0.1 }, { x: 0, y: 0, w: 1, h: 1 });

    expect(box.y + box.h).toBeGreaterThan(1);
  });
});
