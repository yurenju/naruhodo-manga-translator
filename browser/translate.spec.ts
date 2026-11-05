/**
 * #31：side panel 的設定頁輸入 API key → 同意資料使用 → 已啟動的分頁直接翻譯（#93，不必再按「翻譯此頁」）→
 * 逐字稿出現讀音與譯文、狀態列顯示已翻譯。同意寫在 chrome.storage、SW 聽到變更才排翻譯，這段跨 context 的接線只有這裡測得到。
 * 狀態列的格式（模型・秒數・費用、加總）在 src/ui/view.test.ts。
 * FakeTranslator 取代 Claude，但跟正式 build 一樣要先存 key（requireApiKey）。
 * 也檢查 key 不經過 content script 與 messaging（spec #27 第 5 節）。
 */
import type { Page, Worker } from '@playwright/test';
import { activateOnMockSite, expect, openSettings, openSidePanel, test } from './fixtures.ts';

test.use({ viewport: null, fakeTranslator: true, requireApiKey: true, unreadableTexts: ['もちろん！'] });

const FAKE_KEY = 'sk-ant-e2e-not-a-real-key-WXYZ';

const firstTranscript = (panel: Page) =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: '第 1 頁' }).getByRole('list', { name: '逐字稿' });

/** 在 side panel 裡記下所有 runtime 訊息（SW ↔ offscreen 的 sendMessage 也會廣播到這裡）。 */
async function recordPanelMessages(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const g = globalThis as unknown as { __seen: string[] };
    g.__seen = [];
    chrome.runtime.onMessage.addListener((m: unknown) => void g.__seen.push(JSON.stringify(m)));
  });
}

/** 在 content script 的 isolated world 裡記下它收到的所有訊息。 */
async function recordContentMessages(sw: Worker, tabId: number): Promise<void> {
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const g = globalThis as unknown as { __seen: string[] };
        g.__seen = [];
        chrome.runtime.onMessage.addListener((m: unknown) => void g.__seen.push(JSON.stringify(m)));
      },
    });
  }, tabId);
}

/** content script 收到的訊息，以及它的 IndexedDB（頁面的 origin）裡有沒有 API key 的 store。 */
async function contentScriptView(sw: Worker, tabId: number) {
  return sw.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('naruhodo');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stores = [...db.objectStoreNames];
        db.close();
        return { seen: (globalThis as unknown as { __seen: string[] }).__seen, stores };
      },
    });
    return result!.result!;
  }, tabId);
}

test('設定 API key、同意資料使用後，已啟動的分頁直接翻譯：逐字稿出現譯文、狀態列顯示已翻譯；key 不經過 content script', async ({
  context,
  sw,
  extensionId,
  mockSite,
}) => {
  const { panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite, beforeActivate: recordPanelMessages });
  await recordContentMessages(sw, tabId);

  // 還沒有 key：原文＋kuromoji 讀音、未翻譯
  const transcript = firstTranscript(panel);
  await expect(transcript.getByRole('listitem').first()).toBeVisible();
  await expect(transcript.getByText('未翻譯').first()).toBeVisible();
  await expect(panel.getByText('尚未設定 API key')).toBeVisible();
  // 第一次打開就先說明資料會送到 Anthropic（Web Store 的 prominent disclosure）
  const consent = panel.getByRole('region', { name: '資料使用說明' });
  await expect(consent).toContainText('Anthropic');
  await expect(consent).toContainText('不會上傳圖片');
  await expect(consent.getByRole('link', { name: '隱私權政策' })).toHaveAttribute('href', /PRIVACY\.md$/);

  // ⚙：整個 side panel 換成設定頁，輸入 key，只顯示末四碼
  await openSettings(panel);
  const settings = panel.getByRole('region', { name: '設定' });
  await expect(settings).toContainText('Anthropic Console');
  await expect(settings).toContainText('花費上限');
  await settings.getByLabel('Claude API key').fill(FAKE_KEY);
  await settings.getByRole('button', { name: '儲存' }).click();
  await expect(settings).toContainText('末四碼 WXYZ');
  await expect(settings.getByLabel('Claude API key')).toHaveCount(0);
  expect(await panel.locator('body').innerText()).not.toContain(FAKE_KEY);
  await panel.getByRole('button', { name: '返回' }).click();
  await expect(panel.getByText('尚未設定 API key')).toHaveCount(0);

  // 有 key 但還沒同意：送不出去，所以沒有「翻譯此頁」，由資料使用說明卡帶路
  await expect(transcript.getByText('未翻譯').first()).toBeVisible();
  await expect(panel.getByRole('button', { name: '翻譯此頁' })).toHaveCount(0);
  expect(await sw.evaluate(() => globalThis.__translateCalls)).toBe(0);

  // 同意之後卡片消失，已啟動的分頁直接開始翻譯
  await consent.getByRole('button', { name: '同意並啟用翻譯' }).click();
  await expect(consent).toHaveCount(0);
  await expect(transcript.getByText('早安！今天好早喔')).toBeVisible();
  // 讀音換成 Translator 的整句讀音（おはよう！きょうははやいね），以ルビ對齊回漢字
  await expect(transcript.getByRole('listitem').filter({ hasText: '早安！今天好早喔' }).locator('rt')).toHaveText(['きょう', 'はや']);
  await expect(panel.getByRole('contentinfo', { name: '狀態列' })).toContainText(/已翻譯 \d+ 頁/);
  // 都翻好了：底部只有狀態，沒有按鈕（翻好的頁要重翻走過時提示的單頁「重新翻譯」）
  await expect(panel.getByRole('contentinfo', { name: '狀態列' }).getByRole('button')).toHaveCount(0);

  // unreadable：OCR 原文（灰、刪除線）＋「無法辨識 · 未覆蓋」
  const unreadable = transcript.getByRole('listitem').filter({ hasText: '無法辨識' });
  await expect(unreadable).toHaveCount(1);
  await expect(unreadable).toContainText('もちろん');
  const original = unreadable.locator('[lang="ja"]');
  await expect(original).toHaveCSS('text-decoration-line', 'line-through');
  // 灰＝design token --naru-ink-3（#75706A）
  await expect(original).toHaveCSS('color', 'rgb(117, 112, 106)');
  await expect(unreadable.locator('[lang="zh-Hant"]')).toHaveCount(0);
  await expect(unreadable.getByText('未翻譯')).toHaveCount(0);

  // key 不在任何 runtime 訊息裡，content script 也拿不到
  const panelSeen = await panel.evaluate(() => (globalThis as unknown as { __seen: string[] }).__seen);
  expect(panelSeen.some((m) => m.includes('offscreen:translate'))).toBe(true);
  expect(panelSeen.filter((m) => m.includes(FAKE_KEY))).toEqual([]);
  const content = await contentScriptView(sw, tabId);
  expect(content.seen.filter((m) => m.includes(FAKE_KEY))).toEqual([]);
  expect(content.stores).not.toContain('apiKeys');

  // 刪除 key
  await openSettings(panel);
  await settings.getByRole('button', { name: '刪除' }).click();
  await expect(settings.getByLabel('Claude API key')).toBeVisible();
  await expect(settings).not.toContainText('末四碼');
});

test('從 Chrome 內建 side panel 選單打開（沒有啟動 tab）也能設定 API key', async ({ context, extensionId }) => {
  const panel = await openSidePanel(context, extensionId);

  await expect(panel.getByText('請點外掛圖示啟動')).toBeVisible();
  await openSettings(panel);
  const settings = panel.getByRole('region', { name: '設定' });
  await settings.getByLabel('Claude API key').fill(FAKE_KEY);
  await settings.getByRole('button', { name: '儲存' }).click();
  await expect(settings).toContainText('末四碼 WXYZ');

  // 重新打開 side panel 仍然記得（存在 IndexedDB）
  await panel.reload();
  await openSettings(panel);
  await expect(panel.getByRole('region', { name: '設定' })).toContainText('末四碼 WXYZ');
});
