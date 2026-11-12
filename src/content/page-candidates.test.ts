import { describe, expect, it } from 'vitest';
import { isPageCandidate, isStretched, longPageVisible, pageCandidateRejection } from './page-candidates.ts';

const VIEWPORT = { width: 1280, height: 720 };
/** 仿 canvas 網站一頁在畫面上的大小。 */
const page = (x: number, y: number) => ({ x, y, width: 430, height: 625 });

describe('isPageCandidate', () => {
  it('完整落在 viewport 內、夠大的元素是 Page 候選', () => {
    expect(isPageCandidate(page(425, 57), VIEWPORT)).toBe(true);
  });

  it('只露出一部分的不是', () => {
    expect(isPageCandidate(page(425, 699), VIEWPORT)).toBe(false);
    expect(isPageCandidate(page(425, -300), VIEWPORT)).toBe(false);
    expect(isPageCandidate(page(1000, 57), VIEWPORT)).toBe(false);
  });

  it('超出 viewport 幾 px 內仍算完整可見', () => {
    expect(isPageCandidate(page(425, 97), VIEWPORT)).toBe(true); // 下緣 722
    expect(isPageCandidate(page(-2, 57), VIEWPORT)).toBe(true);
  });

  it('太小的元素（圖示、頭像）不是', () => {
    expect(isPageCandidate({ x: 10, y: 10, width: 120, height: 120 }, VIEWPORT)).toBe(false);
    expect(isPageCandidate({ x: 10, y: 10, width: 600, height: 90 }, VIEWPORT)).toBe(false);
  });

  it('高度不到可見高度一半的不是：首頁、結尾推薦區的縮圖一次好幾十張，誤翻會大量花掉額度', () => {
    // 仿網站首頁的正方形宣傳縮圖、結尾的推薦作品縮圖
    expect(isPageCandidate({ x: 36, y: 100, width: 252, height: 252 }, VIEWPORT)).toBe(false);
    expect(isPageCandidate({ x: 225, y: 100, width: 207, height: 300 }, VIEWPORT)).toBe(false);
    expect(isPageCandidate({ x: 10, y: 10, width: 300, height: 359 }, VIEWPORT)).toBe(false);
    expect(isPageCandidate({ x: 10, y: 10, width: 300, height: 360 }, VIEWPORT)).toBe(true);
  });

  it('很高的視窗裡一頁接一頁往下排、同時完整露出兩頁：每頁不到一半，但超過 400 px 仍是候選', () => {
    const tall = { width: 1280, height: 1390 };
    expect(isPageCandidate({ x: 425, y: 80, width: 430, height: 625 }, tall)).toBe(true);
    expect(isPageCandidate({ x: 425, y: 721, width: 430, height: 625 }, tall)).toBe(true);
    expect(isPageCandidate({ x: 36, y: 100, width: 252, height: 252 }, tall)).toBe(false);
  });

  it('矮視窗（筆電）裡的縮圖仍不是', () => {
    const laptop = { width: 1366, height: 650 };
    expect(isPageCandidate({ x: 36, y: 100, width: 252, height: 252 }, laptop)).toBe(false);
    expect(isPageCandidate({ x: 400, y: 10, width: 440, height: 630 }, laptop)).toBe(true);
  });

  it('夠高但太窄的不是（直立的廣告欄）', () => {
    expect(isPageCandidate({ x: 10, y: 10, width: 160, height: 600 }, VIEWPORT)).toBe(false);
  });

  it('被 overflow 裁切的祖先擋住的不是（仿 canvas 網站翻頁：隔壁頁在 viewer 外面）', () => {
    const viewer = { x: 425, y: 57, width: 430, height: 625 };
    expect(isPageCandidate(page(425, 57), VIEWPORT, [viewer])).toBe(true);
    expect(isPageCandidate(page(-5, 57), VIEWPORT, [viewer])).toBe(false);
    // 翻頁動畫中途：一半在 viewer 裡
    expect(isPageCandidate(page(640, 57), VIEWPORT, [viewer])).toBe(false);
  });

  it('不顯示的元素（rect 為 0）不是', () => {
    expect(isPageCandidate({ x: 0, y: 0, width: 0, height: 0 }, VIEWPORT)).toBe(false);
  });
});

describe('pageCandidateRejection（除錯記錄用）', () => {
  it('說明為什麼不是 Page 候選；是候選時回傳 undefined', () => {
    const viewer = { x: 425, y: 57, width: 430, height: 625 };
    expect(pageCandidateRejection(page(425, 57), VIEWPORT, [viewer])).toBeUndefined();
    expect(pageCandidateRejection({ x: 10, y: 10, width: 120, height: 120 }, VIEWPORT)).toBe('small');
    expect(pageCandidateRejection(page(425, 699), VIEWPORT)).toBe('outsideViewport');
    expect(pageCandidateRejection(page(640, 57), VIEWPORT, [viewer])).toBe('clipped');
  });
});

describe('longPageVisible（直式捲動的長 Page）', () => {
  /** 仿直式捲動網站：自己捲動的容器 400×600，長 canvas 寬 400、高 2400。 */
  const scroller = { x: 440, y: 60, width: 400, height: 600 };
  const long = (y: number) => ({ x: 440, y, width: 400, height: 2400 });

  it('比可見範圍高、寬度放得下的是長 Page，回傳看得到的那一截', () => {
    expect(longPageVisible(long(-500), VIEWPORT, [scroller])).toEqual({ x: 440, y: 60, width: 400, height: 600 });
    // 頁的下緣在可見範圍中間
    expect(longPageVisible(long(-2000), VIEWPORT, [scroller])).toEqual({ x: 440, y: 60, width: 400, height: 340 });
  });

  it('沒有裁切祖先時，可見範圍就是 viewport', () => {
    expect(longPageVisible({ x: 100, y: -300, width: 800, height: 3000 }, VIEWPORT)).toEqual({ x: 100, y: 0, width: 800, height: 720 });
  });

  it('寬度放不下（左右被切）的不是', () => {
    expect(longPageVisible({ x: 300, y: -500, width: 600, height: 2400 }, VIEWPORT, [scroller])).toBeUndefined();
  });

  it('比可見範圍矮的不是：只露出一部分時維持「完整可見」的規則', () => {
    expect(longPageVisible(page(425, 300), VIEWPORT)).toBeUndefined();
    expect(longPageVisible(page(425, 57), VIEWPORT)).toBeUndefined();
  });

  it('看得到的那一截太矮（剛捲進來或快捲走）的不是', () => {
    expect(longPageVisible(long(600), VIEWPORT, [scroller])).toBeUndefined();
    expect(longPageVisible(long(-2300), VIEWPORT, [scroller])).toBeUndefined();
  });

  it('太窄的元素不是', () => {
    expect(longPageVisible({ x: 10, y: -100, width: 120, height: 3000 }, VIEWPORT)).toBeUndefined();
  });

  it('橫式翻頁 viewer 的候選結果不變：完整可見的頁不是長 Page', () => {
    const viewer = { x: 425, y: 57, width: 430, height: 625 };
    expect(longPageVisible(page(425, 57), VIEWPORT, [viewer])).toBeUndefined();
    expect(longPageVisible(page(640, 57), VIEWPORT, [viewer])).toBeUndefined();
  });
});

describe('isStretched', () => {
  const full = { x: 0, y: 0, width: 872, height: 1394 };

  it('視窗變窄、閱讀器還沒重新產生圖：舊的 1258×1402 被撐成 872×1394 是變形的過渡畫面，不當 Page 候選', () => {
    expect(isStretched(full, { width: 1258, height: 1402 })).toBe(true);
    expect(pageCandidateRejection(full, { width: 872, height: 1394 }, [], { width: 1258, height: 1402 })).toBe('stretched');
  });

  it('重新產生後（圖跟顯示一樣大，或高 DPI 的兩倍）不算', () => {
    expect(isStretched(full, { width: 872, height: 1394 })).toBe(false);
    expect(isStretched(full, { width: 1744, height: 2788 })).toBe(false);
  });

  it('width／height 屬性跟圖差一點（看不出變形）不算', () => {
    expect(isStretched({ x: 0, y: 0, width: 800, height: 1200 }, { width: 1000, height: 1400 })).toBe(false);
  });

  it('還沒載入（naturalWidth 0）不知道比例，不算', () => {
    expect(isStretched(full, { width: 0, height: 0 })).toBe(false);
  });

  it('不知道圖本身的大小（object-fit 不是 fill）照舊是候選', () => {
    expect(pageCandidateRejection(full, { width: 872, height: 1394 })).toBeUndefined();
  });
});
