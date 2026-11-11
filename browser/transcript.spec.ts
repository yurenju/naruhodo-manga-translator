/**
 * #30：本機偵測＋OCR → side panel 逐字稿。OCR 用 FakeEngine 重播（ADR 0007）；只對真模型有意義的（模型下載、
 * SHA-256 檢查）標 @e2e、在 browser test 跳過，e2e 從 mock site 下載模型（內容是 repo 外的模型快取）、強制 wasm。
 * 閱讀順序、Balloon／Loose Text 的分類、讀音與譯文的規則在 reading-order、analyze、transcribe、ruby 的 unit；
 * 這裡只看 side panel 真的把讀音與標籤畫出來。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { Message, ModelStatus, ModelStatusResponse } from '../src/shared/messages.ts';
import {
  activateOnMockSite,
  configuredServiceWorker,
  expect,
  launchWithExtension,
  test,
} from './fixtures.ts';
import { startMockSite } from './mock-site/server.ts';

/** 跟 pages.spec.ts 一樣用真的視窗：截圖與 rect 才對得上。第 1、2 頁完整可見。 */
test.use({ viewport: null });

const transcriptOf = (panel: Page, pageIndex: number): Locator =>
  panel.getByRole('list', { name: 'Page' }).getByRole('listitem', { name: `第 ${pageIndex + 1} 頁` }).getByRole('list', { name: '逐字稿' });

async function lines(transcript: Locator) {
  return transcript.getByRole('listitem').evaluateAll((items) =>
    items.map((li) => {
      // 預設層級「加上讀音」：原文（lang="ja"）帶 <rt>，對不上時下面是整句讀音（<small>）
      const shown = li.querySelector('[lang="ja"]')!;
      const original = shown.cloneNode(true) as Element;
      const rts = [...original.querySelectorAll('rt, small')].map((rt) => (rt.remove(), rt.textContent ?? ''));
      const badges = [...li.querySelectorAll('span')].filter((s) => s.children.length === 0).map((s) => s.textContent);
      return {
        loose: badges.includes('框外文字'),
        original: original.textContent ?? '',
        hasKanji: /[一-鿿々〆ヶ]/.test(original.textContent ?? ''),
        reading: rts.join(''),
        translation: li.querySelector('[lang="zh-Hant"]')?.textContent ?? null,
        untranslated: badges.includes('未翻譯') ? '未翻譯' : null,
        italic: getComputedStyle(shown).fontStyle === 'italic',
      };
    }),
  );
}

test.describe('沒有 API key', () => {
  test('side panel 畫出原文＋讀音＋「未翻譯」，Loose Text 標「框外文字」', async ({ context, sw, extensionId, mockSite }) => {
    const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });

    const first = transcriptOf(panel, 0);
    await expect(first.getByRole('listitem').first()).toBeVisible();
    const p01 = await lines(first);
    console.log('p01 逐字稿', p01.map((l) => `${l.original}（${l.reading}）`).join(' / '));
    expect(p01.some((l) => l.hasKanji)).toBe(true);
    for (const line of p01) {
      if (line.hasKanji) expect(line.reading).not.toBe('');
      expect(line.untranslated).toBe('未翻譯');
      expect(line.translation).toBeNull();
    }
    await expect(panel.getByText('尚未設定 API key')).toBeVisible();

    // p02 的旁白「潮見坂高校 4月12日」在 Balloon 外，是 Loose Text
    const second = transcriptOf(panel, 1);
    await expect(second.getByRole('listitem').first()).toBeVisible();
    const p02 = await lines(second);
    console.log('p02 逐字稿', p02.map((l) => `[${l.loose ? '框外文字' : 'balloon'}] ${l.original}`).join(' / '));
    expect(p02.some((l) => l.loose)).toBe(true);
    expect(p02.some((l) => !l.loose)).toBe(true);
    // 「框外文字」徽章取代原本的斜體＋🔊
    for (const line of p02) {
      expect(line.original).not.toContain('🔊');
      expect(line.italic).toBe(false);
    }
  });
});

test('模型 SHA-256 不符時不使用並顯示錯誤；修好後按重試就能用', { tag: '@e2e' }, async ({ context, sw, extensionId, mockSite, fakeOcr }) => {
  test.skip(fakeOcr, '需要真的模型，只在 e2e 跑');
  mockSite.corruptModel('onnx/decoder_model_quantized.onnx');
  const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });

  await expect(panel.getByRole('alert')).toContainText('SHA-256 不符');
  await expect(panel.getByRole('alert')).toContainText('decoder_model_quantized.onnx');
  await expect(panel.getByText('辨識失敗').first()).toBeVisible();
  await expect(panel.getByRole('list', { name: '逐字稿' })).toHaveCount(0);

  mockSite.repairModels();
  // 重試會重新擷取：仿 canvas 網站維持在前景（跟真的 side panel 一樣），才截得到它
  await panel.getByRole('button', { name: '重試' }).click();
  await expect(transcriptOf(panel, 0).getByRole('listitem').first()).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('第一次使用時下載模型並顯示進度與大小；重開瀏覽器後不再下載', { tag: '@e2e' }, async ({ fakeOcr }) => {
  test.skip(fakeOcr, '需要真的模型，只在 e2e 跑');
  const userDataDir = await mkdtemp(join(tmpdir(), 'manga-profile-'));
  const site = await startMockSite();
  try {
    // 第一次：下載
    let context = await launchWithExtension(userDataDir);
    let sw = await configuredServiceWorker(context, site);
    let extensionId = new URL(sw.url()).host;
    const { panel } = await activateOnMockSite({ context, sw, extensionId, mockSite: site, beforeActivate: recordModelStatus });
    await expect(transcriptOf(panel, 0).getByRole('listitem').first()).toBeVisible();
    const firstRequests = site.modelRequests.length;
    expect(firstRequests).toBe(4); // detector、encoder、decoder、vocab
    const statuses = await panel.evaluate(() => (globalThis as unknown as { __statuses: ModelStatus[] }).__statuses);
    const downloading = statuses.filter((s) => s.state === 'downloading');
    expect(downloading[0]).toEqual({ state: 'downloading', loaded: 0, total: 127_740_540 });
    expect(downloading.at(-1)).toEqual({ state: 'downloading', loaded: 127_740_540, total: 127_740_540 });
    const ready = await panel.evaluate(
      async (message) => (await chrome.runtime.sendMessage<Message, ModelStatusResponse>(message)).status,
      { type: 'panel:getModelStatus' } satisfies Message,
    );
    console.log('offscreen 的模型狀態', JSON.stringify(ready));
    // manifest 的 COOP／COEP 讓 offscreen document crossOriginIsolated，wasm 才會多執行緒
    expect(ready).toMatchObject({ state: 'ready', executionProvider: 'wasm' });
    expect(ready.state === 'ready' && ready.threads).toBeGreaterThan(1);
    await context.close();

    // 第二次：同一個設定檔，從 Cache Storage 載入
    context = await launchWithExtension(userDataDir);
    sw = await configuredServiceWorker(context, site);
    extensionId = new URL(sw.url()).host;
    const second = await activateOnMockSite({ context, sw, extensionId, mockSite: site });
    await expect(transcriptOf(second.panel, 0).getByRole('listitem').first()).toBeVisible();
    expect(site.modelRequests.length).toBe(firstRequests);
    await context.close();
  } finally {
    await site.close();
    // Windows 上瀏覽器剛關時 lockfile 可能還被占用
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
});

/** 在 side panel 裡記下所有 models:status（本機下載很快，畫面上的進度一閃而過）。 */
async function recordModelStatus(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const g = globalThis as unknown as { __statuses: ModelStatus[] };
    g.__statuses = [];
    chrome.runtime.onMessage.addListener((m: Message) => {
      if (m.type === 'models:status') g.__statuses.push(m.status);
    });
  });
}
