import { describe, expect, it } from 'vitest';
import type { Rect } from '../shared/messages.ts';
import { hammingDistance, pageHash, SAME_PAGE_MAX_DISTANCE } from '../shared/page-hash.ts';
import { cropGray, letterbox, readGray, readGroundTruth } from '../testing/synthetic.ts';
import { cropImage, splitSpread } from './spread.ts';

const box = ({ x, y, width, height }: Rect) => [x, y, width, height];

/** 切出來的邊界跟預期差幾 px 以內（縮放後取整）。 */
const TOLERANCE = 2;

function expectNear(actual: Rect[], expected: Rect[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((rect, i) => {
    const want = expected[i]!;
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(rect[key] - want[key]), `第 ${i} 頁 ${key}：${JSON.stringify(rect)} vs ${JSON.stringify(want)}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });
}

/** ground truth 的 Page 範圍（原圖像素）換到合成圖裡的位置。 */
function expectedPages(id: string, content: Rect): Rect[] {
  const gt = readGroundTruth(id);
  const s = content.width / gt.width;
  return gt.pages.map(({ bbox: [x, y, w, h] }) => ({
    x: Math.round(content.x + x * s),
    y: Math.round(content.y + y * s),
    width: Math.round(w * s),
    height: Math.round(h * s),
  }));
}

/** ground truth 單頁（原圖裁切）的 hash，依閱讀順序。 */
function groundTruthHashes(id: string): string[] {
  const image = readGray(id);
  return readGroundTruth(id).pages.map((p) => pageHash(cropGray(image, p.bbox)));
}

/** 電子書閱讀器實測的幾種視窗：合成圖像素＝viewport×2；橫長視窗黑邊在上下，更寬的視窗在左右。 */
const READER_VIEWPORTS = [
  { width: 3116, height: 2412 },
  { width: 3840, height: 2160 },
  { width: 1500, height: 1000 },
  { width: 1280, height: 931 },
];

describe('Spread 切頁', () => {
  it('p07（Spread）切成兩個 Page，先右後左，邊界與 ground truth 相符', () => {
    const gt = readGroundTruth('p07-spread');
    expect(splitSpread(readGray('p07-spread')).map(box)).toEqual(gt.pages.map((p) => p.bbox));
  });

  for (const id of ['p07-spread', 'p08-action']) {
    for (const viewport of READER_VIEWPORTS) {
      it(`仿電子書閱讀器合成圖（${id}，${viewport.width}×${viewport.height}，黑邊）：去黑邊後切成兩頁，hash 跟原圖單頁是同一頁`, () => {
        const { image, content } = letterbox(readGray(id), viewport);
        const pages = splitSpread(image);
        expectNear(pages, expectedPages(id, content));
        const expected = groundTruthHashes(id);
        pages.forEach((page, i) => {
          expect(hammingDistance(pageHash(cropImage(image, page)), expected[i]!)).toBeLessThanOrEqual(SAME_PAGE_MAX_DISTANCE);
        });
      });
    }
  }

  it('跨頁模式只顯示一頁（封面置中、左右黑邊）：不切，整頁是一個 Page', () => {
    const { image, content } = letterbox(readGray('p01-basic'), { width: 3116, height: 2412 });
    expectNear(splitSpread(image), [content]);
  });

  it('只顯示一頁、另一半是空白黑色：空白那半丟掉', () => {
    // 跨頁的位置（上下黑邊），右半是 p01、左半全黑
    const { image } = letterbox(readGray('p07-spread'), { width: 3116, height: 2412 });
    const right = expectedPages('p07-spread', letterbox(readGray('p07-spread'), { width: 3116, height: 2412 }).content);
    const cover = letterbox(readGray('p01-basic'), { width: right[0]!.width, height: right[0]!.height });
    for (let y = 0; y < right[0]!.height; y++) {
      image.gray.set(cover.image.gray.subarray(y * cover.image.width, (y + 1) * cover.image.width), (right[0]!.y + y) * image.width + right[0]!.x);
      image.gray.fill(0, (right[1]!.y + y) * image.width + right[1]!.x, (right[1]!.y + y) * image.width + right[1]!.x + right[1]!.width);
    }
    expectNear(splitSpread(image), [right[0]!]);
  });

  it('直式視窗的單頁（上下黑邊）：去黑邊後跟跨頁切出來的右頁是同一頁', () => {
    const p07 = readGray('p07-spread');
    const rightPage = cropGray(p07, readGroundTruth('p07-spread').pages[0]!.bbox);
    const { image, content } = letterbox(rightPage, { width: 2200, height: 2600 });
    const pages = splitSpread(image);
    expectNear(pages, [content]);
    expect(hammingDistance(pageHash(cropImage(image, pages[0]!)), groundTruthHashes('p07-spread')[0]!)).toBeLessThanOrEqual(SAME_PAGE_MAX_DISTANCE);
  });

  it('左右黑邊對稱、黑邊裡兩頁的白色留白不一樣寬：照樣去黑邊、從中間切成兩頁', () => {
    // 電子書閱讀器實測：左頁外緣留白比右頁寬（截圖像素差 16 px），黑邊連同留白一起算就不對稱。
    // 視窗夠寬（整張截圖的一半不像漫畫頁）才會出事，用實測的截圖尺寸
    const { image, content } = letterbox(readGray('p07-spread'), { width: 2778, height: 1397 });
    for (let y = content.y; y < content.y + content.height; y++) image.gray.fill(255, y * image.width + content.x, y * image.width + content.x + 40);
    expectNear(splitSpread(image), expectedPages('p07-spread', content));
  });

  it('單側的純黑出血（不對稱）不當黑邊切掉', () => {
    const image = readGray('p08-action');
    for (let y = 0; y < image.height; y++) image.gray.fill(0, y * image.width, y * image.width + 60);
    expect(splitSpread(image).map(box)).toEqual(readGroundTruth('p08-action').pages.map((p) => p.bbox));
  });

  it('深色但不均勻的邊緣（夜景、出血到邊）不當黑邊', () => {
    const image = readGray('p08-action');
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < 40; x++) {
        const v = (x * 7 + y * 3) % 30;
        image.gray[y * image.width + x] = v;
        image.gray[y * image.width + image.width - 1 - x] = v;
      }
    }
    expect(splitSpread(image).map(box)).toEqual(readGroundTruth('p08-action').pages.map((p) => p.bbox));
  });

  it('白底網站上左右留白很寬的 Spread：照樣從中縫切成兩頁（留白跟單頁一樣算在頁面裡）', () => {
    const { image, content } = letterbox(readGray('p07-spread'), { width: 4400, height: 2160 }, 255);
    const seam = expectedPages('p07-spread', content)[0]!.x;
    expectNear(splitSpread(image), [
      { x: seam, y: 0, width: image.width - seam, height: image.height },
      { x: 0, y: 0, width: seam, height: image.height },
    ]);
  });

  it('白色邊框不切（白底網站的頁面留白）', () => {
    const { image } = letterbox(readGray('p01-basic'), { width: 1600, height: 1000 }, 255);
    expect(splitSpread(image).map(box)).toEqual([[0, 0, 1600, 1000]]);
  });

  it('寬 > 高但兩半不像漫畫頁（例如啟動當下工具列整個開著、橫幅圖）：這次不產生 Page', () => {
    const width = 1707;
    const height = 600;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = (i * 37) % 251;
    expect(splitSpread({ gray, width, height })).toEqual([]);
  });
});
