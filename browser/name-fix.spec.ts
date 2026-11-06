/**
 * #228：OCR 讀成形近字的名字，用 Series Notes 換回來再送去翻譯。仿 canvas 網站的翻頁版（第 1 頁 p01、第 2 頁 p02），
 * OCR 用 FakeEngine 重播（ADR 0007）；p02 的錄製資料在「霧島湊」的「島」帶了手寫的候選字（嶋 0.31）。
 * 「霧嶋湊」是測試用的虛構名字。修字的規則（前 3 名、機率門檻、差一個漢字）在 analyze 的 unit，
 * background 什麼時候帶 Notes 在 transcribe 的 unit；這裡只確認 SW 讀出的 Notes 送得到 offscreen、修過的原文送得到翻譯。
 */
import type { Worker } from '@playwright/test';
import type { Series } from '../src/shared/series.ts';
import type { NotesEntry } from '../src/shared/translator.ts';
import { activateOnMockSite, expect, readStore, sentOriginals, test } from './fixtures.ts';

test.use({ viewport: null, fakeTranslator: true });

/** 直接寫一個 Notes 條目進外掛的 IndexedDB（只是測試的前置資料；side panel 沒有新增條目的入口）。 */
function putNote(sw: Worker, entry: NotesEntry): Promise<void> {
  return sw.evaluate(
    (entry) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('naruhodo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('seriesNotes', 'readwrite');
          tx.objectStore('seriesNotes').put(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    entry,
  );
}

test('Series Notes 有這個名字時，OCR 讀成形近字的名字修回來再送去翻譯', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.canvasSitePagedUrl });
  await expect(panel.getByRole('status', { name: '翻譯狀態' })).toHaveText([/^已翻譯・/]);
  const [series] = await readStore<Series>(sw, 'series');
  await putNote(sw, { seriesId: series!.id, 原文: '霧嶋湊', 讀音: 'きりしまみなと', 譯文: '霧嶋湊', 類別: '人名', locked: false });

  // ← 鍵＝下一頁（RTL）：p02 這時才 OCR，拿得到 Notes
  await page.keyboard.press('ArrowLeft');

  await expect.poll(() => sentOriginals(sw)).toContain('転校生の霧嶋湊ですよろしく');
  expect(await sentOriginals(sw)).not.toContain('転校生の霧島湊ですよろしく');
});
