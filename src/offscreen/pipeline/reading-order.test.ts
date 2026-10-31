import { describe, expect, it } from 'vitest';
import { cropGray, readGray, readGroundTruth, SYNTHETIC_IDS, type GtBox } from '../../testing/synthetic.ts';
import { readingOrder, type GrayImage } from './reading-order.ts';

/** 要排進逐字稿、#7 量閱讀順序時算進去的種類（Balloon 與旁白）。 */
const ORDERED_KINDS = new Set(['balloon', 'thought', 'narration']);

/**
 * 已知做不到完全正確的頁，以及至少要有的成對順序正確率（pairwise）。
 * p03：「橫跨格線的 Balloon」把上下兩格連成一個區塊，flood fill 分不開；#7 在這頁是 0.857，Panel 內也跑 XY-cut 後約 0.905。
 */
const KNOWN_LIMITS: Record<string, number> = { 'p03-shapes': 0.9 };

/** 每個合成頁；Spread 依 ground truth 的 pages 切成單頁（index 0＝右頁，先讀）。 */
const SINGLE_PAGES = SYNTHETIC_IDS.flatMap((id) => {
  const gt = readGroundTruth(id);
  return gt.pages.map((page) => ({ name: gt.pages.length > 1 ? `${id}#${page.index}` : id, gt, page }));
});

/** 把 ground truth 的框移到單頁座標，並截掉超出這一頁的部分（跨中縫的狀聲詞）。 */
function toPage([x, y, w, h]: GtBox, [px, py, pw, ph]: GtBox): GtBox {
  const x1 = Math.max(x, px);
  const y1 = Math.max(y, py);
  const x2 = Math.min(x + w, px + pw);
  const y2 = Math.min(y + h, py + ph);
  return [x1 - px, y1 - py, x2 - x1, y2 - y1];
}

/** 成對順序正確的比例（#7 score.mjs 的定義）。 */
function pairwise(expected: string[], actual: string[]): number {
  let ok = 0;
  let total = 0;
  for (let i = 0; i < expected.length; i++) {
    for (let j = i + 1; j < expected.length; j++) {
      total++;
      if (actual.indexOf(expected[i]!) < actual.indexOf(expected[j]!)) ok++;
    }
  }
  return total ? ok / total : 1;
}

function blankPage(width: number, height: number): GrayImage {
  return { gray: new Uint8Array(width * height).fill(255), width, height };
}

/** 畫 3 px 寬的黑色框線。 */
function strokeRect({ gray, width }: GrayImage, [x, y, w, h]: GtBox): void {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (i - x < 3 || x + w - 1 - i < 3 || j - y < 3 || y + h - 1 - j < 3) gray[j * width + i] = 0;
    }
  }
}

describe('readingOrder：flood fill 找 Panel＋XY-cut', () => {
  it.each(SINGLE_PAGES.map((p) => [p.name, p] as const))('%s：Balloon 與旁白依 ground truth 的閱讀順序排列', (name, { gt, page }) => {
    const image = gt.pages.length > 1 ? cropGray(readGray(gt.id), page.bbox) : readGray(gt.id);
    const texts = gt.texts
      .filter((t) => (t.page ?? 0) === page.index && ORDERED_KINDS.has(t.kind))
      .map((t) => ({ id: t.id, bbox: toPage(t.bbox, page.bbox) }));
    const expected = texts.map((t) => t.id);
    // 打亂輸入，確定結果只看座標
    const actual = readingOrder([...texts].reverse(), image).map((t) => t.id);

    const score = pairwise(expected, actual);
    console.log(`${name} 閱讀順序 pairwise ${score.toFixed(3)}：${actual.join(' ')}（ground truth ${expected.join(' ')}）`);
    const limit = KNOWN_LIMITS[name];
    if (limit === undefined) expect(actual).toEqual(expected);
    else expect(score).toBeGreaterThanOrEqual(limit);
  });

  it('跨格線的框把三格連成一個 Panel 時，旁白仍依格的順序排列', () => {
    // 上排右格 A、左格 B，下排整列 C；兩個跨格線的框把三格的框線連在一起
    const image = blankPage(600, 900);
    strokeRect(image, [310, 20, 270, 410]); // A
    strokeRect(image, [20, 20, 270, 410]); // B
    strokeRect(image, [20, 450, 560, 430]); // C
    strokeRect(image, [260, 300, 80, 60]); // 跨 A、B 之間的直向格線
    strokeRect(image, [100, 400, 100, 80]); // 跨 B、C 之間的橫向格線
    const narrations = [
      { id: 'A', bbox: [520, 40, 50, 160] as GtBox },
      { id: 'B', bbox: [230, 40, 50, 160] as GtBox },
      { id: 'C', bbox: [530, 470, 40, 170] as GtBox },
    ];

    expect(readingOrder([...narrations].reverse(), image).map((t) => t.id)).toEqual(['A', 'B', 'C']);
  });

  it('同樣的框不管輸入順序都得到同樣的結果', () => {
    const image = readGray('p05-dense');
    const texts = readGroundTruth('p05-dense').texts.map((t) => ({ id: t.id, bbox: t.bbox }));

    expect(readingOrder(texts, image)).toEqual(readingOrder([...texts].reverse(), image));
  });
});
