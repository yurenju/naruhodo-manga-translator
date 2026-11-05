import type { Page } from '@playwright/test';
import { readGroundTruth } from '../src/testing/synthetic.ts';
import { activateOnMockSite, expect, rescan, test } from './fixtures.ts';

/**
 * 用真的視窗（1280×1500）而不是 Playwright 模擬的 viewport：啟動時 side panel 會真的打開、把頁面擠窄，
 * 模擬的 viewport 不會跟著變，量到的 rect 就跟 captureVisibleTab 的截圖對不上（真實 Chrome 沒有這個問題）。
 * 可視高度約 1390 px；仿 canvas 網站每頁顯示 430×625、間隔 16 px，header 下方第 1、2 頁完整可見，第 3 頁只露出上半部。
 *
 * 認頁靠 FakeTranslator：它把 OCR 原文對回全部合成頁的 ground truth，所以逐字稿裡出現的譯文屬於哪一張
 * 合成頁，就知道裁出來的是哪一頁；裁切偏掉時會混進別頁的句子或認不出來。
 */
test.use({ viewport: null, fakeTranslator: true });

/** 仿 canvas 網站前三頁；第 3 頁永遠只露出一部分，用來確認不會誤認成它。 */
const FIRST_PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes'];

/** 一頁 7 句裡至少要認出這麼多句才算「是這一頁」（截圖裡的 Page 只有原圖約一半大，OCR 偶爾漏一句）。 */
const MIN_MATCHED_LINES = 5;

const pageList = (panel: Page) => panel.getByRole('list', { name: 'Page' });

/** 逐字稿裡出現了哪幾張合成頁的譯文，各幾句。 */
async function groundTruthHits(panel: Page, name: string): Promise<Record<string, number>> {
  const text = await pageList(panel).getByRole('listitem', { name }).getByRole('list', { name: '逐字稿' }).innerText();
  return Object.fromEntries(FIRST_PAGES.map((id) => [id, readGroundTruth(id).texts.filter((t) => text.includes(t.zh)).length]));
}

/** side panel 依序列出的 Page 正好是 ids：頁首「第 1 頁」…，每頁逐字稿只有那張合成頁的譯文。 */
async function expectPagesListed(panel: Page, ids: string[]): Promise<void> {
  const names = ids.map((_, i) => `第 ${i + 1} 頁`);
  await expect(pageList(panel).getByRole('heading')).toHaveText(names);
  for (const [i, id] of ids.entries()) {
    await expect
      .poll(async () => (await groundTruthHits(panel, names[i]!))[id], { message: `${names[i]} 是 ${id}` })
      .toBeGreaterThanOrEqual(MIN_MATCHED_LINES);
    const others = Object.entries(await groundTruthHits(panel, names[i]!)).filter(([other, n]) => other !== id && n > 0);
    expect(others, `${names[i]} 混進別頁的句子`).toEqual([]);
  }
}

/** 頁首的小圖示（裝飾用、aria-hidden），只拿來數格子。 */
const pageIcon = (panel: Page, name: string) => pageList(panel).getByRole('listitem', { name }).locator('svg').first();

// 排序、左右頁、頁首文字的規則在 src/ui/view.test.ts；這裡只確認 side panel 真的把它們畫出來

test('啟動後 side panel 列出完整可見的 Page，只露出一部分的不列；單頁的頁首圖示一格', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  await expectPagesListed(panel, ['p01-basic', 'p02-ruby']);
  await expect(pageIcon(panel, '第 1 頁').locator('rect')).toHaveCount(1);
});

test('捲動後重新擷取：上下都只露出一部分時只列中間那頁', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await expectPagesListed(panel, ['p01-basic', 'p02-ruby']);

  await page.evaluate(() => window.scrollTo(0, 300));
  await rescan(panel, tabId);

  await expectPagesListed(panel, ['p02-ruby']);
});

test('Spread 的兩個 Page 頁首是「右頁 · 先讀」「左頁 · 後讀」，右頁在前；沒有縮圖', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.ebookReaderUrl });

  // 左右頁怎麼判斷、頁首文字是 view.test.ts 的 unit；這是唯一一條讓真的 Spread（SW 切成兩頁）一路畫到 side panel 的
  await expect(pageList(panel).getByRole('heading')).toHaveText(['右頁 · 先讀', '左頁 · 後讀']);
  await expect(pageList(panel).getByRole('img')).toHaveCount(0);
  // 頁首圖示畫兩格（Spread）
  await expect(pageIcon(panel, '右頁 · 先讀').locator('rect')).toHaveCount(2);
});

test('每個 Page 的翻譯狀態在頁首右側，跟標題同一行', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  for (const name of ['第 1 頁', '第 2 頁']) {
    const item = pageList(panel).getByRole('listitem', { name });
    const status = item.getByRole('status', { name: '翻譯狀態' });
    // 狀態列的格式在 view.test.ts；這裡只看它畫在哪裡
    await expect(status).toHaveText(/^已翻譯・/);
    const heading = (await item.getByRole('heading', { name }).boundingBox())!;
    const box = (await status.boundingBox())!;
    expect(box.x, `${name} 狀態在標題右邊`).toBeGreaterThan(heading.x + heading.width);
    expect(box.y, `${name} 狀態跟標題同一行`).toBeLessThan(heading.y + heading.height);
    expect(box.y + box.height).toBeGreaterThan(heading.y);
  }
});

test.describe('DPR 1.5', () => {
  test.use({ realDeviceScaleFactor: 1.5 });

  test('裁切位置仍正確', async ({ context, sw, extensionId, mockSite }) => {
    const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });

    expect(await page.evaluate(() => devicePixelRatio)).toBe(1.5);
    await expectPagesListed(panel, ['p01-basic', 'p02-ruby']);
  });
});
