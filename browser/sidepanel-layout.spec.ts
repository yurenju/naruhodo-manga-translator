/**
 * #77：side panel 的版面。底部系列名稱原本是一個很寬的下拉選單，把窄的 side panel 撐出水平捲軸；#186 起作品在 Transcript 上方的作品卡。
 */
import type { Page } from '@playwright/test';
import { activateOnMockSite, chooseFromPanelMenu, expect, openPanelMenu, test } from './fixtures.ts';

/** Chrome side panel 能拉到的最窄寬度附近。 */
const NARROW = { width: 320, height: 800 };

const LONG_NAME = 'ある日突然、異世界の大魔法使いの弟子になった件について 第二部';

/** 整頁沒有水平捲軸：內容寬度不超過可視寬度。 */
async function expectNoHorizontalScroll(panel: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await panel.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

/** 跟 series.spec.ts 一樣用真的視窗：仿 canvas 網站兩頁都截得到。 */
test.use({ fakeTranslator: true, viewport: null });

test('窄寬度下 side panel 沒有水平捲軸', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await expect(panel.getByRole('status', { name: '翻譯狀態' }).filter({ hasText: /^已翻譯・/ })).toHaveCount(2);
  // mock 網站的作品名很短；真實網站的作品名與網域長得多，舊版的下拉選單縮不到比最長選項窄
  const card = panel.getByRole('region', { name: '作品' });
  const sheet = panel.getByRole('dialog', { name: '這頁是哪部作品？' });
  await card.getByRole('button', { name: '換一部' }).click();
  await sheet.getByRole('button', { name: '改名…' }).click();
  await sheet.getByRole('textbox', { name: '作品名稱' }).fill(LONG_NAME);
  await sheet.getByRole('button', { name: '儲存' }).click();
  await expect(card).toContainText(LONG_NAME);
  await panel.setViewportSize(NARROW);

  // 平常：作品卡的長名稱換行或截斷，不撐開
  await expectNoHorizontalScroll(panel);
  // 拉出的作品清單（裡面有長名稱與合併的下拉選單）也不撐開
  await card.getByRole('button', { name: '更改' }).click();
  await expect(sheet).toBeVisible();
  await expectNoHorizontalScroll(panel);
  await sheet.getByRole('button', { name: '關閉' }).click();
  // ⚙ 選單展開、從選單打開的區塊也一樣
  await openPanelMenu(panel);
  await expectNoHorizontalScroll(panel);
  await chooseFromPanelMenu(panel, '設定');
  await expect(panel.getByRole('region', { name: '設定' })).toBeVisible();
  await expectNoHorizontalScroll(panel);
});

test.describe('逐字稿出來之前', () => {
  // 顯示層級的按鈕要等逐字稿出來才有；FakeEngine 幾乎不花時間，讓它慢到測試結束都還沒出來
  test.use({ fakeOcrDelayMs: 60_000 });

  test('頂部只有 logo、名稱、狀態、停止、⚙ 與 Page Mode 切換', async ({ context, sw, extensionId, mockSite }) => {
    const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });
    const main = panel.getByRole('main');

    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Naruhodo');
    await expect(main.getByText('已啟動')).toBeVisible();
    // 還沒同意資料使用時，說明卡片固定在最上面（translate.spec.ts 測它）；同意後才是平常的版面
    const consent = main.getByRole('region', { name: '資料使用說明' });
    await consent.getByRole('button', { name: '同意並啟用翻譯' }).click();
    await expect(consent).toHaveCount(0);
    // Page 列表與逐字稿之前的控制項：停止、⚙（只有圖示）、Page Mode 兩格（含副標）、作品卡的問句列（#186）。顯示層級要等逐字稿出來，不在這裡
    await expect(main.getByRole('button').filter({ visible: true })).toHaveText(['停止', '', /^閱讀/, /^學習/, '是', '換一部']);
    await expect(main.getByRole('button', { name: '設定', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(main.getByRole('switch')).toHaveCount(0);

    // ⚙ 選單收著不常用的功能
    const menu = await openPanelMenu(panel);
    await expect(menu.getByRole('switch', { name: '自動翻譯' })).toHaveAccessibleDescription('翻頁就翻，關掉只顯示快取');
    await expect(menu.getByRole('button', { name: '重新擷取頁面' })).toHaveAccessibleDescription('翻頁沒被偵測到時用');
    await expect(menu.getByRole('button')).toHaveText([/^重新擷取頁面/, '角色與用語', '設定']);
    // 按 Esc 收起
    await panel.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});
