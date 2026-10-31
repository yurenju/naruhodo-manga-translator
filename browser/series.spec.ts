/**
 * #36：Series 選擇與歸類。網址模式＝origin＋path；選定非 Provisional 的 Series 後才記住。
 * 「停止」後再啟動才是新的一次啟動（已啟動的 tab 重新整理會沿用同一個 Series），所以每次都先停止再重新整理。
 */
import type { Page, Worker } from '@playwright/test';
import type { Message, SeriesResponse } from '../src/shared/messages.ts';
import type { PageTranslation } from '../src/shared/page-text.ts';
import type { Series } from '../src/shared/series.ts';
import { activateOnMockSite, expect, readStore, testActivate, test } from './fixtures.ts';

/** 跟 cache.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。 */
test.use({ viewport: null });

const footer = (panel: Page) => panel.getByRole('contentinfo', { name: '狀態列' });
/** 底部那一行「系列＋名稱＋鉛筆」；平常只顯示名稱。 */
const seriesRow = (panel: Page) => footer(panel).getByRole('group', { name: '系列' });
/** 點鉛筆展開編輯區（改名、切換、新增、合併都在裡面）。 */
const openSeriesEditor = (panel: Page) => footer(panel).getByRole('button', { name: '改系列名稱' }).click();
const seriesSelect = (panel: Page) => footer(panel).getByRole('combobox', { name: 'Series', exact: true });

async function createSeries(panel: Page, name: string): Promise<void> {
  await openSeriesEditor(panel);
  await seriesSelect(panel).selectOption({ label: '新增 Series…' });
  await panel.getByRole('textbox', { name: 'Series 名稱' }).fill(name);
  await panel.getByRole('button', { name: '建立' }).click();
  await expect(seriesRow(panel)).toContainText(name);
}

/** 停止 → 重新整理 → 再啟動（新的一次啟動，要靠網址模式預選）。 */
async function stopReloadActivate(page: Page, panel: Page, tabId: number): Promise<void> {
  await panel.getByRole('button', { name: '停止' }).click();
  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await page.reload();
  await page.locator('body[data-ready="true"]').waitFor();
  await page.bringToFront();
  await testActivate(panel, tabId);
  await expect(panel.getByText('已啟動')).toBeVisible();
}

/** 這個 tab 目前的 Series ID（問 SW）。 */
const currentSeries = async (panel: Page, tabId: number) =>
  (await panel.evaluate((m) => chrome.runtime.sendMessage<Message, SeriesResponse>(m), { type: 'panel:getSeries', tabId } satisfies Message)).current;

const seriesNamed = async (sw: Worker, name: string) => (await readStore<Series>(sw, 'series')).find((s) => s.name === name);

// 規則（網址模式怎麼比對、預選時不再建 Provisional、改名 ID 不變、合併時快取與 Notes 怎麼併）在 series 與 series-catalog
// 的 unit；這裡只確認 side panel 的操作會經過 SW 寫進 IndexedDB（預選那條再確認下一次啟動讀得回來）。

test('選 Series 後重新整理再啟動，自動預選同一部 Series', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await expect(seriesRow(panel)).toContainText(/未歸類（未命名・127\.0\.0\.1・/);

  await createSeries(panel, '範例作品');
  await stopReloadActivate(page, panel, tabId);

  await expect(seriesRow(panel)).toContainText('範例作品');
});

// #145：換不換、對不上就沿用是 activation 與 series-catalog 的 unit；這裡確認真的導航會經過 SW 換掉 Series，side panel 跟著顯示
test('同分頁導航回記住了另一部 Series 的網址：side panel 換成那部 Series', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await createSeries(panel, '作品甲');
  const first = await currentSeries(panel, tabId);

  // 另一部作品：對不上網址模式就沿用作品甲，讀者在這裡新增作品乙（記住這個網址）
  const otherWork = new URL('other-work/', mockSite.canvasSiteUrl).href;
  await page.goto(otherWork);
  await page.locator('body[data-ready="true"]').waitFor();
  await expect(seriesRow(panel)).toContainText('作品甲');
  await createSeries(panel, '作品乙');

  await page.goto(mockSite.canvasSiteUrl);
  await page.locator('body[data-ready="true"]').waitFor();

  await expect(seriesRow(panel)).toContainText('作品甲');
  expect(await currentSeries(panel, tabId)).toBe(first);
});

test('Provisional Series 在 side panel 改名：顯示新名稱，也寫進 store', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await expect(seriesRow(panel)).toContainText(/未歸類（/);

  // 平常只是文字；點鉛筆才出現輸入框
  await expect(footer(panel).getByRole('textbox')).toHaveCount(0);
  await openSeriesEditor(panel);
  await panel.getByRole('textbox', { name: '新名稱' }).fill('範例作品');
  await panel.getByRole('button', { name: '儲存' }).click();
  await expect(seriesRow(panel)).toContainText('範例作品');
  // 改名後 ID 不變、不再是 Provisional 是 series-catalog 的 unit；這裡只確認改名有經過 SW 寫進去
  await expect.poll(() => seriesNamed(sw, '範例作品')).toBeDefined();
});

test.describe('合併（FakeTranslator）', () => {
  test.use({ fakeTranslator: true });

  test('Provisional Series 合併進既有 Series：store 裡快取改掛目標、臨時 Series 刪掉，不重翻', async ({ context, sw, extensionId, mockSite }) => {
    const first = await activateOnMockSite({ context, sw, extensionId, mockSite });
    const statusLines = first.panel.getByRole('status', { name: '翻譯狀態' });
    await expect(statusLines.filter({ hasText: /^已翻譯・/ })).toHaveCount(2);
    await createSeries(first.panel, '範例作品');
    const target = (await seriesNamed(sw, '範例作品'))!;
    // 選了新的 Series 會重新擷取、用新 ID 翻譯：等它寫完，目標就有這兩頁的快取
    await expect.poll(async () => (await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === target.id).length).toBe(2);

    const other = await activateOnMockSite({ context, sw, extensionId, mockSite, url: new URL('episode-2/', mockSite.canvasSiteUrl).href });
    await expect(other.panel.getByRole('status', { name: '翻譯狀態' }).filter({ hasText: /^已翻譯・/ })).toHaveCount(2);
    const provisionalId = (await currentSeries(other.panel, other.tabId))!;
    expect((await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === provisionalId)).toHaveLength(2);
    const calls = await sw.evaluate(() => globalThis.__translateCalls ?? 0);

    await openSeriesEditor(other.panel);
    await other.panel.getByRole('combobox', { name: '合併進' }).selectOption({ label: '範例作品' });
    await other.panel.getByRole('button', { name: '合併' }).click();

    await expect(seriesRow(other.panel)).toContainText('範例作品');
    await expect.poll(async () => (await readStore<Series>(sw, 'series')).some((s) => s.id === provisionalId)).toBe(false);
    const cached = await readStore<PageTranslation>(sw, 'pageTranslations');
    expect(cached.filter((t) => t.seriesId === provisionalId)).toEqual([]);
    // 兩集是同一個仿 canvas 網站：hash 相同，保留目標原本的兩頁，不會變成 4 頁
    expect(cached.filter((t) => t.seriesId === target.id)).toHaveLength(2);
    expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(calls);
  });
});
