/**
 * #109：產品網站首頁的互動展示。對 `npm run site:build` 產生的 site/dist 開一個靜態 server，用一般的瀏覽器（不載入外掛）操作。
 * unit 抓不到的：Astro／Vite 打包外掛元件的整條路（.css 變字串、字型檔、合成頁圖片）、SidePanel 在 shadow root 裡真的
 * render、覆蓋層在真正的版面上 hover 出 tooltip 並跟 side panel 同步高亮，以及展示時沒有對外的網路請求。
 * 展示的進度（辨識中 → 翻譯中 → 完成、剩餘頁數、圖示當開關）是 site/src/demo/demo-state.test.ts。
 */
import { test as base, expect } from '@playwright/test';
import { demoPage } from '../site/src/demo/demo-page.ts';
import { startSiteServer } from './site-server.ts';

const test = base.extend<{ siteOrigin: string }>({
  siteOrigin: async ({}, use) => {
    const site = await startSiteServer();
    await use(site.origin);
    await site.close();
  },
});

test('首頁展示：點圖示 → 翻譯完成 → 切到學習 → 滑過對話框看到 tooltip，全程不連外', async ({ page, siteOrigin }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${siteOrigin}/zh-tw/`);

  const demo = page.locator('.demo-chrome');
  await demo.getByRole('button', { name: 'Naruhodo', exact: true }).click();
  // Playwright 的 locator 會穿進 open shadow root
  const panel = demo.locator('.naru-side-panel');
  await expect(panel.getByRole('status', { name: '剩餘額度' })).toHaveText(/免費額度剩 99 頁/);

  const balloons = demoPage.text.balloons;
  const translations = demo.locator('[data-naruhodo-overlay] [data-balloon-id]');
  await expect(translations.filter({ visible: true })).toHaveCount(balloons.length);

  await panel.getByRole('button', { name: /^學習/ }).click();
  await expect(translations.filter({ visible: true })).toHaveCount(0);

  // 譯文元素藏起來後 rect 不變（visibility），拿它當 Balloon 的位置；漫畫頁會捲動，先捲到看得到
  const first = translations.first();
  await first.scrollIntoViewIfNeeded();
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tooltip = demo.locator('[data-naruhodo-overlay] .tip.on');
  await expect(tooltip).toHaveCount(1);
  const id = await first.getAttribute('data-balloon-id');
  // 學習時 tooltip 是原文夾著振り仮名（rt），拿掉再比
  const withoutRuby = await tooltip.evaluate((tip) => {
    const copy = tip.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('rt').forEach((rt) => rt.remove());
    return copy.textContent;
  });
  expect(withoutRuby).toContain(balloons.find((b) => b.id === id)!.原文);
  // 同步高亮：side panel 逐字稿裡那句也亮起來
  await expect(panel.locator('li.hl')).toHaveCount(1);

  // 圖示是開關：再點一次停止、關掉 side panel、拿掉譯文；再點又重新翻一次
  const icon = demo.getByRole('button', { name: 'Naruhodo', exact: true });
  await icon.click();
  await expect(icon).toHaveAttribute('aria-pressed', 'false');
  await expect(panel).toHaveCount(0);
  await expect(translations).toHaveCount(0);
  await icon.click();
  await expect(panel.getByRole('status', { name: '剩餘額度' })).toHaveText(/免費額度剩 99 頁/);

  expect(requests.filter((url) => !url.startsWith(`${siteOrigin}/`))).toEqual([]);
});
