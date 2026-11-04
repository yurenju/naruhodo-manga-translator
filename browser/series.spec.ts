/**
 * #36、#186：Series 的選擇與自動歸類。網址模式＝origin＋path；確認過的 Series 才記住。網址模式對不上時從頁面標題猜作品原名
 * （FakeTranslator 的 fakeSeriesGuess：仿 canvas 網站每一話的標題相同，所以猜到同一個原名）。
 * 「停止」後再啟動才是新的一次啟動（已啟動的 tab 重新整理會沿用同一個 Series），所以每次都先停止再重新整理。
 */
import type { Page, Worker } from '@playwright/test';
import type { Message, SeriesResponse } from '../src/shared/messages.ts';
import type { PageTranslation } from '../src/shared/page-text.ts';
import type { Series } from '../src/shared/series.ts';
import { activateOnMockSite, expect, readStore, testActivate, test } from './fixtures.ts';

/** 跟 cache.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。 */
test.use({ viewport: null });

/** Transcript 上方的作品卡。 */
const card = (panel: Page) => panel.getByRole('region', { name: '作品' });
/** 作品頁的身分區、換一部作品頁（#191）。 */
const identity = (panel: Page) => panel.getByRole('region', { name: '作品身分' });
const picker = (panel: Page) => panel.getByRole('region', { name: '換一部作品' });
const back = (panel: Page) => panel.getByRole('button', { name: '返回' }).click();

/** 點作品卡打開作品頁，再進換一部作品（Provisional 是問句列的「換一部」「選一部」，確認過的是「不是這部作品？」）。 */
async function openPicker(panel: Page): Promise<void> {
  await card(panel).getByRole('button', { name: /^作品：/ }).click();
  await identity(panel).getByRole('button', { name: /^(換一部|選一部|不是這部作品？)$/ }).click();
  await expect(picker(panel)).toBeVisible();
}

/** 換一部作品 → 新增作品；建好回到作品頁，再「←」回到逐字稿。 */
async function createSeries(panel: Page, name: string): Promise<void> {
  await openPicker(panel);
  await picker(panel).getByRole('button', { name: '＋ 新增作品…' }).click();
  await picker(panel).getByRole('textbox', { name: '新作品名稱' }).fill(name);
  await picker(panel).getByRole('button', { name: '建立' }).click();
  await expect(identity(panel)).toContainText(name);
  await back(panel);
  await expect(card(panel)).toContainText(name);
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

// 規則（網址模式怎麼比對、原名怎麼比對、優先順序、選擇與合併時記住原名、改名 ID 不變、合併時快取與 Notes 怎麼併）在 series、
// series-catalog 與 activation 的 unit；這裡只確認 side panel 的操作會經過 SW 寫進 IndexedDB，以及頁面標題真的會從分頁經過 SW 歸類。

test('選 Series 後重新整理再啟動，自動預選同一部 Series', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  // 沒有 Translator（還沒同意資料使用）就不猜，建未命名的
  await expect(card(panel)).toContainText(/未命名・127\.0\.0\.1・/);
  await expect(card(panel)).toContainText('看不出是哪部作品');

  await createSeries(panel, '範例作品');
  await stopReloadActivate(page, panel, tabId);

  await expect(card(panel)).toContainText('範例作品');
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
  await expect(card(panel)).toContainText('作品甲');
  await createSeries(panel, '作品乙');

  await page.goto(mockSite.canvasSiteUrl);
  await page.locator('body[data-ready="true"]').waitFor();

  await expect(card(panel)).toContainText('作品甲');
  expect(await currentSeries(panel, tabId)).toBe(first);
});

test('猜不出作品時在作品卡「取名字」：打開作品頁的取名字表單，存好後顯示新名稱、不再問，也寫進 store', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  await card(panel).getByRole('button', { name: '取名字' }).click();
  await identity(panel).getByRole('textbox', { name: '作品名稱' }).fill('範例作品');
  await identity(panel).getByRole('button', { name: '儲存' }).click();
  await expect(identity(panel)).toContainText('範例作品');
  await back(panel);

  await expect(card(panel)).toContainText('範例作品');
  await expect(card(panel).getByRole('group', { name: '確認作品' })).toHaveCount(0);
  // 改名後 ID 不變、不再是 Provisional 是 series-catalog 的 unit；這裡只確認改名有經過 SW 寫進去
  await expect.poll(() => seriesNamed(sw, '範例作品')).toBeDefined();
});

test.describe('FakeTranslator', () => {
  test.use({ fakeTranslator: true });

  // #186 的代表路徑：unit 看不到「分頁的標題 → SW 猜原名 → IndexedDB 的 Series → side panel 作品卡」這串
  test('兩個分頁讀不同話：從頁面標題猜到同一個原名，歸到同一部；按「是」確認', async ({ context, sw, extensionId, mockSite }) => {
    const first = await activateOnMockSite({ context, sw, extensionId, mockSite });
    await expect(card(first.panel)).toContainText('（譯名）');
    await expect(card(first.panel)).toContainText('這是正確的作品嗎？');
    const seriesId = await currentSeries(first.panel, first.tabId);

    const second = await activateOnMockSite({ context, sw, extensionId, mockSite, url: new URL('episode-2/', mockSite.canvasSiteUrl).href });
    await expect(card(second.panel)).toContainText('（譯名）');
    expect(await currentSeries(second.panel, second.tabId)).toBe(seriesId);

    await card(second.panel).getByRole('button', { name: '是' }).click();

    await expect(card(second.panel).getByRole('group', { name: '確認作品' })).toHaveCount(0);
    // 作品卡只有名稱兩行（#191）；確認過了沒有在作品頁看
    await card(second.panel).getByRole('button', { name: /^作品：/ }).click();
    await expect(identity(second.panel)).toContainText('已確認');
    await expect.poll(async () => (await readStore<Series>(sw, 'series')).find((s) => s.id === seriesId)?.provisional).toBe(false);
  });

  test('Provisional Series 合併進既有 Series：store 裡快取改掛目標、臨時 Series 刪掉，不重翻', async ({ context, sw, extensionId, mockSite }) => {
    const first = await activateOnMockSite({ context, sw, extensionId, mockSite });
    const statusLines = first.panel.getByRole('status', { name: '翻譯狀態' });
    await expect(statusLines.filter({ hasText: /^已翻譯・/ })).toHaveCount(2);
    await createSeries(first.panel, '範例作品');
    const target = (await seriesNamed(sw, '範例作品'))!;
    // 選了新的 Series 會重新擷取、用新 ID 翻譯：等它寫完，目標就有這兩頁的快取
    await expect.poll(async () => (await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === target.id).length).toBe(2);

    // 標題清掉：猜不出作品，建未命名的 Provisional Series（猜得到的話會直接歸到範例作品）
    const other = await activateOnMockSite({
      context,
      sw,
      extensionId,
      mockSite,
      url: new URL('episode-2/', mockSite.canvasSiteUrl).href,
      beforeActivate: (_panel, page) => page.evaluate(() => void (document.title = '')),
    });
    await expect(other.panel.getByRole('status', { name: '翻譯狀態' }).filter({ hasText: /^已翻譯・/ })).toHaveCount(2);
    const provisionalId = (await currentSeries(other.panel, other.tabId))!;
    expect((await readStore<PageTranslation>(sw, 'pageTranslations')).filter((t) => t.seriesId === provisionalId)).toHaveLength(2);
    const calls = await sw.evaluate(() => globalThis.__translateCalls ?? 0);

    await openPicker(other.panel);
    await picker(other.panel).getByRole('combobox', { name: '合併進' }).selectOption({ label: '範例作品' });
    await picker(other.panel).getByRole('button', { name: '合併' }).click();

    await expect(identity(other.panel)).toContainText('範例作品');
    await back(other.panel);
    await expect(card(other.panel)).toContainText('範例作品');
    await expect.poll(async () => (await readStore<Series>(sw, 'series')).some((s) => s.id === provisionalId)).toBe(false);
    const cached = await readStore<PageTranslation>(sw, 'pageTranslations');
    expect(cached.filter((t) => t.seriesId === provisionalId)).toEqual([]);
    // 兩集是同一個仿 canvas 網站：hash 相同，保留目標原本的兩頁，不會變成 4 頁
    expect(cached.filter((t) => t.seriesId === target.id)).toHaveLength(2);
    expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(calls);
  });
});
