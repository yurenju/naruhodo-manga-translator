import {
  activateOnMockSite,
  expect,
  isContentScriptInjected,
  openMockSite,
  openSettings,
  openSidePanel,
  tabIdOf,
  test,
  testActivate,
  testStop,
} from './fixtures.ts';

/** 載入完成後給 SW 的 tabs.onUpdated 一點時間；用在「應該不會注入」的斷言。 */
const SETTLE_MS = 1000;

test('mock site 的 canvas 是 tainted（getImageData 會丟錯）', async ({ context, mockSite }) => {
  const page = await openMockSite(context, mockSite);

  const error = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.page canvas')!;
    try {
      canvas.getContext('2d')!.getImageData(0, 0, 1, 1);
      return null;
    } catch (e) {
      return (e as DOMException).name;
    }
  });

  expect(error).toBe('SecurityError');
});

test('透過測試入口啟動後 side panel 顯示「已啟動」，content script 已注入', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  await openMockSite(context, mockSite);
  const tabId = await tabIdOf(sw, mockSite.canvasSiteUrl);
  const panel = await openSidePanel(context, extensionId, tabId);
  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();

  await testActivate(panel, tabId);

  await expect(panel.getByText('已啟動')).toBeVisible();
  expect(await isContentScriptInjected(sw, tabId)).toBe(true);
});

test('同 origin 重新整理後 content script 自動重新注入', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  await page.reload();

  await expect.poll(() => isContentScriptInjected(sw, tabId)).toBe(true);
  await expect(panel.getByText('已啟動')).toBeVisible();
});

test('停止（再點一次圖示）後清掉 content script，重新整理也不再注入', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  await testStop(panel, tabId);

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await expect.poll(() => isContentScriptInjected(sw, tabId)).toBe(false);
  await page.reload();
  await page.waitForTimeout(SETTLE_MS);
  expect(await isContentScriptInjected(sw, tabId)).toBe(false);
});

test('換 origin 就停止', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  await page.goto(`${mockSite.imageOrigin}/p01-basic.png`);

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  expect(await isContentScriptInjected(sw, tabId)).toBe(false);
});

// unit 看不到的：side panel 頁面的開關真的寫進 chrome.storage.local，SW 那邊（另一個 context）讀得到同一個值
test('側邊欄設定的「點圖示時也打開側邊欄」預設開著，關掉後存成關（#269）', async ({ context, sw, extensionId }) => {
  const panel = await openSidePanel(context, extensionId);
  await openSettings(panel);
  const toggle = panel.getByRole('region', { name: '設定' }).getByRole('switch', { name: '點圖示時也打開側邊欄' });
  await expect(toggle).toBeChecked();

  await toggle.click();

  await expect(toggle).not.toBeChecked();
  await expect.poll(() => sw.evaluate(() => chrome.storage.local.get('sidePanelOnActivation'))).toEqual({ sidePanelOnActivation: false });
});
