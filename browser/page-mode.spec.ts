/**
 * #73 Page Mode（閱讀／學習）：全域記住，學習時頁面保留日文原稿。OCR 用 FakeEngine 重播（ADR 0007），譯文來自 FakeTranslator。
 * 頁面上的內容與 hover 在 overlay.spec.ts、learning.spec.ts；這裡是記住設定、學習時認頁。
 * 認頁與快取命中的規則在 page-hash 與 transcribe 的 unit。
 */
import type { Page, Worker } from '@playwright/test';
import { activateOnMockSite, chooseFromPanelMenu, expect, openSidePanel, test, testActivate } from './fixtures.ts';
import { overlayTexts, pageMode, shownTranslations } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

const translateCalls = (sw: Worker) => sw.evaluate(() => globalThis.__translateCalls ?? 0);
const captureCount = (sw: Worker) => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);
const statusLines = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });

test('Page Mode 在重開 side panel、新分頁啟動後沿用', async ({ context, sw, extensionId, mockSite }) => {
  const first = await activateOnMockSite({ context, sw, extensionId, mockSite });
  // 先等第一個分頁翻好：之後換別的分頁到前景，它就截不到了
  await expect.poll(async () => (await overlayTexts(first.page)).length).toBeGreaterThan(0);
  await pageMode(first.panel, '學習').click();
  await expect(pageMode(first.panel, '學習')).toHaveAttribute('aria-pressed', 'true');

  // 重開 side panel
  await first.panel.close();
  const reopened = await openSidePanel(context, extensionId, first.tabId);
  await expect(pageMode(reopened, '學習')).toHaveAttribute('aria-pressed', 'true');
  await reopened.close();

  // 新分頁啟動：翻好後頁面上有覆蓋層（hover 要用），但看不到譯文
  const second = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(pageMode(second.panel, '學習')).toHaveAttribute('aria-pressed', 'true');
  // 同一個仿 canvas 網站的標題相同，新分頁自動歸到同一部作品（#186），第一個分頁翻好的頁直接從快取來
  await expect(statusLines(second.panel)).toHaveText([/^快取・/]);
  await expect.poll(async () => (await overlayTexts(second.page)).length).toBeGreaterThan(0);
  await expect(shownTranslations(second.page)).toHaveCount(0);

  // 在新分頁切回閱讀：所有分頁共用，第一個分頁也跟著顯示譯文
  await pageMode(second.panel, '閱讀').click();
  await expect(shownTranslations(second.page)).not.toHaveCount(0);
  await expect(shownTranslations(first.page)).not.toHaveCount(0);
});

test('學習時重新擷取：頁面上沒蓋東西的截圖也認得是同一頁，不重翻', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
  await pageMode(panel, '學習').click();
  await expect(shownTranslations(page)).toHaveCount(0);
  expect(await translateCalls(sw)).toBe(1);

  const captures = await captureCount(sw);
  await chooseFromPanelMenu(panel, '重新擷取頁面');
  await expect.poll(() => captureCount(sw)).toBeGreaterThan(captures);
  // 斷言「沒有重翻」：等一段時間確認翻譯次數沒變
  await page.waitForTimeout(1_000);
  expect(await translateCalls(sw)).toBe(1);
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
});

test('學習時重新整理再啟動（快取命中）：頁面上從頭到尾沒出現過譯文', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(statusLines(panel)).toHaveText([/^已翻譯・/]);
  await pageMode(panel, '學習').click();
  await expect(shownTranslations(page)).toHaveCount(0);

  // 重新整理後的頁面每一格畫面都檢查一次：只要有一格看得到譯文就記下來
  await page.addInitScript(() => {
    const w = window as unknown as { __sawTranslation: boolean };
    w.__sawTranslation = false;
    const check = () => {
      for (const host of document.querySelectorAll('[data-naruhodo-overlay]'))
        for (const el of host.shadowRoot?.querySelectorAll<HTMLElement>('[data-balloon-id]') ?? [])
          if (el.checkVisibility({ visibilityProperty: true })) w.__sawTranslation = true;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await page.bringToFront();
  await testActivate(panel, tabId);
  await expect(statusLines(panel)).toHaveText([/^快取・/]);
  // 覆蓋層畫好了（hover 要用），但頁面上從來沒有看得到的譯文
  await expect.poll(async () => (await overlayTexts(page)).length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __sawTranslation: boolean }).__sawTranslation)).toBe(false);
});
