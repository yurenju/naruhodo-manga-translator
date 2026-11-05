/**
 * #34：翻頁偵測與自動翻譯的串接。用仿 canvas 網站的翻頁版（一次一頁、RTL、450 ms 動畫）。
 * OCR 用 FakeEngine 重播（ADR 0007），譯文來自 FakeTranslator（SW 的 __translateCalls 記被呼叫幾次）。
 * 翻譯佇列（後進先出、翻走的丟掉）的規則在 transcribe 的 unit。
 */
import type { Page, Worker } from '@playwright/test';
import { activateOnMockSite, expect, test } from './fixtures.ts';

test.use({ viewport: null, fakeTranslator: true });

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);
const captureCount = (sw: Worker) => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);

const statusLines = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });

/** 有覆蓋層譯文的 canvas 是第幾頁（0 起算）。 */
function overlaidPages(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.viewer canvas')];
    const pages = [...document.querySelectorAll('[data-naruhodo-overlay]')]
      .filter((host) => host.shadowRoot!.querySelector('[data-balloon-id]'))
      .map((host) => canvases.indexOf(host.previousElementSibling!));
    return [...new Set(pages)].sort((a, b) => a - b);
  });
}

const expectOverlaid = (page: Page, index: number) => expect.poll(async () => (await overlaidPages(page)).includes(index)).toBe(true);

/** ← 鍵＝下一頁（RTL）。 */
async function nextPage(page: Page): Promise<void> {
  await page.keyboard.press('ArrowLeft');
}

test('翻頁後新 Page 自動翻譯並覆蓋；翻回來命中快取', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });

  await expectOverlaid(page, 0);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
  expect(await translateCalls(sw)).toBe(1);

  await nextPage(page);
  await expectOverlaid(page, 1);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
  expect(await translateCalls(sw)).toBe(2);

  await page.keyboard.press('ArrowRight');
  await expect(statusLines(panel)).toHaveText([/^快取・/]);
  expect(await translateCalls(sw)).toBe(2);
  await expectOverlaid(page, 0);

  // 自己的覆蓋層（插入 host、截圖前後隱藏）不算翻頁：停下來之後不會一直截圖
  // 翻頁後的那串擷取（動畫中的翻頁訊號、補截帶覆蓋層的樣子）要先跑完：最後一次截圖已經過了 1 秒。
  // 一直截圖停不下來的話，這裡就會逾時
  await expect.poll(() => sw.evaluate(() => Date.now() - (globalThis.__captureLog?.at(-1) ?? 0))).toBeGreaterThan(1_000);
  const settled = await captureCount(sw);
  await page.waitForTimeout(2_000);
  expect(await captureCount(sw)).toBeLessThanOrEqual(settled + 1);
});
