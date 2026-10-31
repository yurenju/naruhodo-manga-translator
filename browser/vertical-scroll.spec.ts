/**
 * 直式捲動的長 Page（spec #142）：比可見範圍高的長 canvas 跟著捲動辨識並覆蓋。
 * unit 測不到的：真的捲動容器裡量到的可見範圍、捲動停下觸發的擷取、截圖裁出的那一截進流水線、
 * 覆蓋層蓋在長 canvas 上、SW 與 side panel 之間的接線。長圖判斷、橫條指紋、切到／重疊的框、Line 的排序與
 * 「同一截不重做、命中快取」在 page-candidates、long-page、transcribe 的 unit。
 */
import type { Page, Worker } from '@playwright/test';
import { activateOnMockSite, expect, test } from './fixtures.ts';
import { VERTICAL_VIEW_HEIGHT } from './mock-site/vertical-scroll.ts';
import { shownTranslations } from './overlay-helpers.ts';

/** 跟 pages.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。 */
test.use({ viewport: null, fakeTranslator: true });

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);
const captureCount = (sw: Worker) => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);

/** content script（isolated world）記下的每次截圖時覆蓋層被藏了多久；沒藏的截圖不記。 */
async function overlayHiddenMs(sw: Worker, tabId: number): Promise<number[]> {
  return sw.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__overlayHiddenMs ?? [] });
    return (result?.result as number[] | undefined) ?? [];
  }, tabId);
}

const scrollTo = (page: Page, top: number) => page.locator('#scroller').evaluate((el, top) => (el.scrollTop = top), top);

/** side panel 逐字稿裡的譯文，依顯示順序。 */
const translations = (panel: Page) => panel.getByRole('list', { name: '逐字稿' }).locator('[lang="zh-Hant"]').allTextContents();

test('長圖被認成一個 Page：捲動停下後看得到的 Balloon 被翻譯、覆蓋；捲回已翻過的地方不再翻譯', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.verticalScrollUrl });

  // 第一截（第 1 張合成頁）
  await expect(panel.getByText('早安！今天好早喔')).toBeVisible();
  await expect(shownTranslations(page).first()).toBeVisible();
  expect(await translateCalls(sw)).toBe(1);

  // 捲到第二截：只翻新收的，併進同一個 Page，side panel 依 Page 座標由上到下
  await scrollTo(page, VERTICAL_VIEW_HEIGHT);
  await expect(panel.getByText('我是轉學生霧島湊，請多指教')).toBeVisible();
  expect(await translateCalls(sw)).toBe(2);
  await expect(panel.getByRole('list', { name: '逐字稿' })).toHaveCount(1);
  const order = await translations(panel);
  expect(order.indexOf('早安！今天好早喔')).toBeLessThan(order.indexOf('我是轉學生霧島湊，請多指教'));

  // 捲回第一截：截圖、辨識照做，但框都跟已收 Line 重疊，不再翻譯。截圖時不藏覆蓋層（中文不閃回日文）
  const captures = await captureCount(sw);
  await scrollTo(page, 0);
  await expect.poll(() => captureCount(sw)).toBeGreaterThan(captures);
  await expect.poll(() => sw.evaluate(() => Date.now() - (globalThis.__captureLog?.at(-1) ?? 0))).toBeGreaterThan(1_000);
  expect(await translateCalls(sw)).toBe(2);
  await expect(shownTranslations(page).first()).toBeVisible();
  expect(await overlayHiddenMs(sw, tabId)).toEqual([]);
});
