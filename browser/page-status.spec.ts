/**
 * 蓋在 Page 上的狀態（#185）：沒開側邊欄的讀者也看得到翻譯中。
 * unit 測不到的：SW 把狀態送到 content script、真的畫在 anchor 上（真實的 DOM 排版），不推動網站的版面、不擋點擊，
 * 截圖時藏起來（不然小標籤的字會進 OCR），翻完拿掉。顯示什麼文字、什麼時候算出問題在 src/shared/page-status.test.ts；
 * 額度用完的紅標籤在 hosted-translation.spec.ts。
 */
import type { Page } from '@playwright/test';
import { activateOnMockSite, expect, test } from './fixtures.ts';
import { shownTranslations } from './overlay-helpers.ts';

// OCR 慢一點，翻譯中的狀態才看得到
test.use({ viewport: null, fakeTranslator: true, fakeOcrDelayMs: 1500 });

const chip = (page: Page) => page.locator('[data-naruhodo-overlay] .st-chip');
const bar = (page: Page) => page.locator('[data-naruhodo-overlay] .st-bar');

const firstCanvasRect = (page: Page) =>
  page.evaluate(() => {
    const { x, y, width, height } = document.querySelector('canvas')!.getBoundingClientRect();
    return { x, y, width, height };
  });

test('翻譯中 Page 上出現細進度條與小標籤，翻完就拿掉；網站版面不動、點得到 Page', async ({ context, sw, extensionId, mockSite }) => {
  let before: Awaited<ReturnType<typeof firstCanvasRect>> | undefined;
  const { page } = await activateOnMockSite({
    context,
    sw,
    extensionId,
    mockSite,
    beforeActivate: async (_panel, page) => void (before = await firstCanvasRect(page)),
  });

  await expect(chip(page).first()).toHaveText('辨識文字…');
  await expect(bar(page).first()).toBeVisible();
  expect(await firstCanvasRect(page)).toEqual(before);
  // 狀態層 pointer-events: none：小標籤底下點到的是 Page 本身。截圖時狀態層會藏一下，所以在頁面裡一次量完、等到看得見的那一刻
  await expect
    .poll(() =>
      page.evaluate(() => {
        const chip = document.querySelector('[data-naruhodo-overlay]')?.shadowRoot?.querySelector('.st-chip');
        const box = chip?.getBoundingClientRect();
        if (!box || box.width === 0) return 'no chip';
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.tagName;
      }),
    )
    .toBe('CANVAS');

  await expect(shownTranslations(page).first()).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  expect(await firstCanvasRect(page)).toEqual(before);
});
