/**
 * #38：Series Notes 管理、過時提示與匯出／匯入。仿 canvas 網站的翻頁版，OCR 用 FakeEngine 重播（ADR 0007）；FakeTranslator 在
 * Balloon 裡看到「パン」（p01）、「霧島湊」（p02）就新增條目，條目已經在 Notes 裡就補空欄位、譯文不同就提建議。
 */
import type { Page } from '@playwright/test';
import type { PageTranslation } from '../src/shared/page-text.ts';
import type { NotesEntry } from '../src/shared/translator.ts';
import { activateOnMockSite, configuredServiceWorker, expect, launchWithExtension, openSettings, openSidePanel, readStore, retranslateVisible, test } from './fixtures.ts';

const パン = { 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' };
const 霧島湊 = { 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名' };

// 陣列第二個元素是物件時，Playwright 會把它當成 [值, 選項]，所以要用 tuple 寫法
test.use({ viewport: null, fakeTranslator: true, fakeNotes: [[パン, 霧島湊], { scope: 'test' }] });

const statusLine = (panel: Page) => panel.getByRole('status', { name: '翻譯狀態' });
const staleHint = (panel: Page) => panel.getByRole('group', { name: '過時提示' });
const notesSection = (panel: Page) => panel.getByRole('region', { name: '角色與用語' });

/** 角色與用語在作品頁裡（#191）：點作品卡打開。 */
async function openNotes(panel: Page): Promise<void> {
  await panel.getByRole('region', { name: '作品' }).getByRole('button', { name: /^作品：/ }).click();
  await expect(notesSection(panel)).toBeVisible();
}

/** 作品頁是整頁（#93、#191）：按「←」回到逐字稿。 */
async function backToTranscript(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: '返回' }).click();
  await expect(notesSection(panel)).toHaveCount(0);
}

/** 編輯一個條目：只改給的欄位，存好後回到逐字稿。 */
async function editNote(panel: Page, 原文: string, fields: Record<string, string>): Promise<void> {
  const section = notesSection(panel);
  await section.getByRole('button', { name: `編輯 ${原文}` }).click();
  for (const [label, value] of Object.entries(fields)) await section.getByRole('textbox', { name: label, exact: true }).fill(value);
  await section.getByRole('button', { name: '儲存' }).click();
  await expect(section.getByRole('row', { name: new RegExp(原文) })).toContainText(Object.values(fields)[0]!);
  await backToTranscript(panel);
}

const entryOf = async (sw: Parameters<typeof readStore>[0], 原文: string) =>
  (await readStore<NotesEntry>(sw, 'seriesNotes')).find((e) => e.原文 === 原文);

/**
 * 快取記的是翻譯（①）送出時 Notes 裡的條目（ADR 0005），第 1 頁翻譯時パン還不在 Notes 裡。
 * 等背景整理（②）把パン寫進 Notes，再重新翻譯 p01，讓它的快取記下用到パン。
 */
async function retranslateWithパン(sw: Parameters<typeof readStore>[0], panel: Page, tabId: number): Promise<void> {
  await expect.poll(async () => (await entryOf(sw, 'パン'))?.譯文).toBe('麵包');
  await retranslateVisible(panel, tabId);
  await expect
    .poll(async () => (await readStore<PageTranslation>(sw, 'pageTranslations')).flatMap((t) => t.usedNotes.map((u) => u.原文)))
    .toEqual(['パン']);
}

// 規則（locked 之後 LLM 只能提建議、接受建議、哪些改動算過時、匯出不含 API key、匯出再匯入一致）在 series-notes、
// notes-ledger、transcribe、backup 的 unit；這裡只確認 side panel ↔ SW ↔ IndexedDB 接得起來。

test('在 side panel 編輯條目會寫進 Notes（locked）；重新翻譯後 LLM 的建議列出來，按接受寫回', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/]);
  await retranslateWithパン(sw, panel, tabId);
  await openNotes(panel);
  await expect(notesSection(panel).getByRole('row', { name: /パン/ })).toContainText('麵包');

  await editNote(panel, 'パン', { 譯文: '胖' });
  await expect.poll(() => entryOf(sw, 'パン')).toMatchObject({ 譯文: '胖', locked: true });

  // 這頁用到パン：馬上出現過時提示；重新翻譯時 FakeTranslator 想把譯文改回麵包，變成建議
  await page.bringToFront();
  await staleHint(panel).getByRole('button', { name: '重新翻譯' }).click();
  await expect(staleHint(panel)).toBeHidden();
  await openNotes(panel);
  const suggestion = notesSection(panel).getByRole('listitem').filter({ hasText: 'パン' });
  await expect(suggestion).toContainText('麵包');

  await suggestion.getByRole('button', { name: '接受' }).click();
  await expect.poll(() => entryOf(sw, 'パン')).toMatchObject({ 譯文: '麵包', locked: true });
  await expect(suggestion).toBeHidden();
});

test('在別頁改了某頁用到的條目，翻回那頁（快取）出現過時提示', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/]);
  await retranslateWithパン(sw, panel, tabId);

  // ← 鍵＝下一頁（RTL）；在 p02 改 p01 用到的パン
  await page.keyboard.press('ArrowLeft');
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/]);
  await openNotes(panel);
  await editNote(panel, 'パン', { 譯文: '胖' });
  await expect.poll(() => entryOf(sw, 'パン')).toMatchObject({ 譯文: '胖' });

  await page.bringToFront();
  await page.keyboard.press('ArrowRight');
  await expect(staleHint(panel)).toContainText('角色與用語已更新');
  await expect(panel.getByRole('contentinfo', { name: '狀態列' })).toContainText('角色與用語已更新');
});

test('匯出 JSON 真的下載得到檔案，在乾淨的 profile 選檔匯入後 Notes 與快取都在', async ({ context, sw, extensionId, mockSite }) => {
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(statusLine(panel)).toHaveText([/^已翻譯・/]);
  // Notes 在背景整理（ADR 0005）：寫進去之後再匯出
  await expect.poll(async () => (await entryOf(sw, 'パン'))?.譯文).toBe('麵包');
  await openSettings(panel);

  const downloading = panel.waitForEvent('download');
  await panel.getByRole('button', { name: '匯出 JSON' }).click();
  const file = await (await downloading).path();

  const clean = await launchWithExtension('');
  try {
    const cleanSw = await configuredServiceWorker(clean, mockSite);
    const cleanPanel = await openSidePanel(clean, new URL(cleanSw.url()).host);
    await openSettings(cleanPanel);
    await cleanPanel.getByLabel('匯入 JSON').setInputFiles(file);
    await expect(cleanPanel.getByText('匯入完成')).toBeVisible();

    expect(await readStore<NotesEntry>(cleanSw, 'seriesNotes')).toEqual([expect.objectContaining({ 原文: 'パン', 譯文: '麵包' })]);
    expect(await readStore<PageTranslation>(cleanSw, 'pageTranslations')).toHaveLength(1);
  } finally {
    await clean.close();
  }
});
