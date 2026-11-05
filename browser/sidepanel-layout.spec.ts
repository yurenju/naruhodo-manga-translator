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
  const identity = panel.getByRole('region', { name: '作品身分' });
  const picker = panel.getByRole('region', { name: '換一部作品' });
  const back = () => panel.getByRole('button', { name: '返回' }).click();
  await card.getByRole('button', { name: /^作品：/ }).click();
  await identity.getByRole('button', { name: '改名' }).click();
  await identity.getByRole('textbox', { name: '作品名稱' }).fill(LONG_NAME);
  await identity.getByRole('button', { name: '儲存' }).click();
  await expect(identity).toContainText(LONG_NAME);
  await panel.setViewportSize(NARROW);

  // 作品頁（長名稱、角色與用語表格）與換一部作品（長名稱與合併的下拉選單）都不撐開（#191）
  await expectNoHorizontalScroll(panel);
  await identity.getByRole('button', { name: '不是這部作品？' }).click();
  await expect(picker).toBeVisible();
  await expectNoHorizontalScroll(panel);
  await back();
  await back();
  // 平常：作品卡的長名稱換行或截斷，不撐開
  await expect(card).toContainText(LONG_NAME);
  await expectNoHorizontalScroll(panel);
  // ⚙ 選單展開、從選單打開的區塊也一樣
  await openPanelMenu(panel);
  await expectNoHorizontalScroll(panel);
  await chooseFromPanelMenu(panel, '設定');
  await expect(panel.getByRole('region', { name: '設定' })).toBeVisible();
  await expectNoHorizontalScroll(panel);
});

/**
 * 字型：side panel 只用系統字型（src/shared/tokens.css）。清單怎麼排由 src/shared/tokens.test.ts 檢查；
 * 實際畫字用了哪個字型（缺字時 Chrome 會改用別的字型補、system-ui 會跟著作業系統語系），要真的 Chrome 才看得到。
 * 只在 Windows 與 macOS 跑：CI 的 Linux 沒有這兩個系統的字型，結果沒有意義。
 */
test('逐字稿的日文全部用日文系統字型、中文全部用中文系統字型，沒有混用', async ({ context, sw, extensionId, mockSite }) => {
  test.skip(process.platform === 'linux', 'Linux 沒有 Windows／macOS 的系統字型');
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  const transcript = panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });
  await expect(transcript.locator('[lang="zh-Hant"]').first()).toBeVisible();

  // 每個字實際用哪個字型畫（含缺字時補上的字型）：CDP 的 CSS.getPlatformFontsForNode
  const cdp = await context.newCDPSession(panel);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const fontsFor = async (lang: string) => {
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: `ol[aria-label="逐字稿"] [lang="${lang}"]` });
    expect(nodeIds.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const nodeId of nodeIds) for (const f of (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts) used.add(f.familyName);
    return [...used];
  };
  const japanese = ['Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', 'Yu Gothic'];
  const chinese = ['Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei UI', 'Microsoft JhengHei'];
  const ja = await fontsFor('ja');
  const zh = await fontsFor('zh-Hant');
  expect(ja.filter((f) => !japanese.includes(f)), `日文用了 ${ja.join('、')}`).toEqual([]);
  expect(zh.filter((f) => !chinese.includes(f)), `中文用了 ${zh.join('、')}`).toEqual([]);
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
    // 作品卡本身是一顆按鈕（打開作品頁，#191），問句列在它下面
    await expect(main.getByRole('button').filter({ visible: true })).toHaveText(['停止', '', /^閱讀/, /^學習/, /›$/, '是', '換一部']);
    await expect(main.getByRole('button', { name: '設定', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(main.getByRole('switch')).toHaveCount(0);

    // ⚙ 選單收著不常用的功能
    const menu = await openPanelMenu(panel);
    await expect(menu.getByRole('switch', { name: '自動翻譯' })).toHaveAccessibleDescription('翻頁就翻，關掉只顯示快取');
    await expect(menu.getByRole('button', { name: '重新擷取頁面' })).toHaveAccessibleDescription('翻頁沒被偵測到時用');
    // 角色與用語在作品頁（#191），不在 ⚙ 選單
    await expect(menu.getByRole('button')).toHaveText([/^重新擷取頁面/, '設定']);
    // 按 Esc 收起
    await panel.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});
