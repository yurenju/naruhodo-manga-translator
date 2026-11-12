import { describe, expect, it } from 'vitest';
import { frameMarkGeometry, judgeFrame } from './frame-mark.ts';

const MAGENTA = [255, 0, 255] as const;
const GREEN = [0, 255, 0] as const;
const BLACK = [0, 0, 0] as const;

describe('judgeFrame', () => {
  it('左右顏色跟這次的 mark 一樣就是準備好之後的 frame', () => {
    expect(judgeFrame(MAGENTA, GREEN, 0)).toBe('fresh');
    expect(judgeFrame(GREEN, MAGENTA, 1)).toBe('fresh');
  });

  it('是另一個 mark 的顏色：上一次截圖的 frame', () => {
    expect(judgeFrame(GREEN, MAGENTA, 0)).toBe('stale');
    expect(judgeFrame(MAGENTA, GREEN, 1)).toBe('stale');
  });

  it('沒有記號（電子書閱讀器的黑邊、網頁內容）', () => {
    expect(judgeFrame(BLACK, BLACK, 0)).toBe('missing');
    // 只有一邊對上也不算
    expect(judgeFrame(MAGENTA, BLACK, 0)).toBe('missing');
  });

  it('容許截圖色彩轉換造成的小誤差', () => {
    expect(judgeFrame([230, 20, 240], [15, 236, 30], 0)).toBe('fresh');
  });
});

describe('frameMarkGeometry', () => {
  it('DPR 1：取兩個像素的中心，蓋掉的範圍多留一個像素', () => {
    expect(frameMarkGeometry({ width: 1280, height: 720 }, { width: 1280, height: 720 })).toEqual({
      samples: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      eraseRect: { x: 0, y: 0, width: 3, height: 2 },
    });
  });

  it('DPR 1.5：依截圖與 viewport 的比例換算', () => {
    expect(frameMarkGeometry({ width: 1280, height: 720 }, { width: 1920, height: 1080 })).toEqual({
      samples: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
      eraseRect: { x: 0, y: 0, width: 4, height: 3 },
    });
  });
});
