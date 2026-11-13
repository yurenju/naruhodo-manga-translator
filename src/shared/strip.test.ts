import { describe, expect, it } from 'vitest';
import { junctionVerdict, stitchWindow, stripPages, stripPagesAdded } from './strip.ts';

/** 一列有內容的像素：亮暗交錯的線條。 */
const art = (shift = 0) => Array.from({ length: 400 }, (_, x) => (Math.floor((x + shift) / 7) % 3 === 0 ? 30 : 235));
const flat = (value: number) => Array.from({ length: 400 }, () => value);

describe('交界上下兩列接不接得起來', () => {
  it('兩列幾乎一樣而且有內容：同一張圖被切開（continuous）', () => {
    const below = art().map((v, x) => v + (x % 5) - 2);

    expect(junctionVerdict(art(), below)).toMatchObject({ verdict: 'continuous' });
  });

  it('兩列都是留白或同一個底色：看不出來（blank）', () => {
    expect(junctionVerdict(flat(255), flat(255)).verdict).toBe('blank');
    expect(junctionVerdict(flat(255), flat(250)).verdict).toBe('blank');
  });

  it('上面是圖、下面是留白，或兩邊是不同的圖：接不起來（break）', () => {
    expect(junctionVerdict(art(), flat(255)).verdict).toBe('break');
    expect(junctionVerdict(art(), art(11)).verdict).toBe('break');
    expect(junctionVerdict(flat(255), flat(0)).verdict).toBe('break');
  });

  it('兩列各只有幾個黑點、位置不同：平均差很小也不算接得起來', () => {
    const dots = (at: number[]) => flat(255).map((v, x) => (at.includes(x) ? 0 : v));
    const above = dots([10, 11, 12, 200, 201]);
    const below = dots([90, 91, 92, 300, 301]);

    const measure = junctionVerdict(above, below);

    expect(measure.diff).toBeLessThan(16);
    expect(measure.verdict).toBe('break');
  });
});

describe('相鄰兩次截圖怎麼拼', () => {
  // 可見範圍是截圖的第 0～1224 列
  const current = { top: 0, bottom: 1224 };

  it('往下捲了不到一個畫面、有框被上緣切到：上一次的範圍接在上面，視窗到被切的框底下一點為止', () => {
    // 上一次的範圍換到這次的座標：往上 450 列
    const stitched = stitchWindow(current, { top: -450, bottom: 774 }, [{ top: 0, bottom: 300 }], []);

    expect(stitched).toEqual({ window: { top: -450, bottom: 332 }, seam: 0, edge: 'top' });
  });

  it('往上捲、有框被下緣切到：上一次的範圍接在下面', () => {
    const stitched = stitchWindow(current, { top: 450, bottom: 1674 }, [], [{ top: 1000, bottom: 1224 }]);

    expect(stitched).toEqual({ window: { top: 968, bottom: 1674 }, seam: 1224, edge: 'bottom' });
  });

  it('一次捲超過一個畫面（兩次的範圍沒有接上）不拼', () => {
    expect(stitchWindow(current, { top: -2000, bottom: -776 }, [{ top: 0, bottom: 300 }], [])).toBeUndefined();
  });

  it('被切的那一緣不是接上一次截圖的那一緣（往下捲、框被下緣切到）不拼：等它之後出現', () => {
    expect(stitchWindow(current, { top: -450, bottom: 774 }, [], [{ top: 1000, bottom: 1224 }])).toBeUndefined();
  });
});

describe('Strip 照句數計頁', () => {
  it('每 8 句一頁，無條件進位，第 1 句就計第 1 頁', () => {
    expect([0, 1, 8, 9, 16, 21].map(stripPages)).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it('這次要多計幾頁：看累計跨過幾個 8 句', () => {
    expect(stripPagesAdded(0, 1)).toBe(1);
    expect(stripPagesAdded(3, 5)).toBe(0);
    expect(stripPagesAdded(8, 1)).toBe(1);
    expect(stripPagesAdded(0, 20)).toBe(3);
  });
});
