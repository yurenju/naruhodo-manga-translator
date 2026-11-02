/**
 * #169 預先下載辨識模型：onboarding 按「開始設定」→ SW → offscreen 只把模型下載進 Cache Storage，進度廣播到 onboarding 與 side panel；
 * 之後真的翻譯時從快取載入，不再下載。unit 測不到的：onboarding、SW、offscreen 之間的訊息，與真的 Cache Storage。
 * 下載與快取的規則（只下載不載入、同時只有一個下載、進度只有一份）在 src/offscreen/models/model-store.test.ts，
 * 藥丸的文字在 src/shared/model-download.test.ts，SW 回答 downloaded 的判斷在 src/background/model-status.test.ts。
 * FakeEngine 不下載模型，所以只在 e2e 跑。
 */
import type { Page } from '@playwright/test';
import { MODEL_SETS, modelSetBytes } from '../src/offscreen/models/model-files.ts';
import type { Message, ModelStatus, ModelStatusResponse } from '../src/shared/messages.ts';
import { activateOnMockSite, expect, openSidePanel, test } from './fixtures.ts';

/** e2e 強制 wasm：下載的是 wasm 那一組。 */
const WASM_BYTES = modelSetBytes(MODEL_SETS.wasm);

/** 記下這一頁收到的所有 models:status（本機下載很快，畫面上的進度一閃而過）。 */
async function recordModelStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __statuses: ModelStatus[] };
    g.__statuses = [];
    chrome.runtime.onMessage.addListener((m: Message) => {
      if (m.type === 'models:status') g.__statuses.push(m.status);
    });
  });
}

const statusesOf = (page: Page) => page.evaluate(() => (globalThis as unknown as { __statuses: ModelStatus[] }).__statuses);

test('onboarding 按「開始設定」就在背景下載模型，side panel 看到同一份進度；之後翻譯不再下載', { tag: '@e2e' }, async ({ fakeOcr, context, sw, extensionId, mockSite }) => {
  test.skip(fakeOcr, '需要真的下載模型，只在 e2e 跑');
  const onboarding = await context.newPage();
  await onboarding.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await expect(onboarding.getByText('會在背景下載辨識日文的模型（約 128 MB，只需要一次）')).toBeVisible();
  const panel = await openSidePanel(context, extensionId);
  await recordModelStatus(onboarding);
  await recordModelStatus(panel);

  await onboarding.getByRole('button', { name: '開始設定' }).click();

  await expect(onboarding.getByRole('status').filter({ hasText: '✓ 辨識模型已就緒' })).toBeVisible();
  expect(mockSite.modelRequests).toHaveLength(4); // detector、encoder、decoder、vocab
  const seen = await statusesOf(panel);
  expect(seen.filter((s) => s.state === 'downloading').at(-1)).toEqual({ state: 'downloading', loaded: WASM_BYTES, total: WASM_BYTES });
  expect(seen.at(-1)).toEqual({ state: 'downloaded' });
  expect(await statusesOf(onboarding)).toEqual(seen);
  const { status } = await panel.evaluate((message) => chrome.runtime.sendMessage<Message, ModelStatusResponse>(message), { type: 'panel:getModelStatus' } satisfies Message);
  expect(status).toEqual({ state: 'downloaded' });

  const activated = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await expect(activated.panel.getByRole('list', { name: '逐字稿' }).first().getByRole('listitem').first()).toBeVisible();
  expect(mockSite.modelRequests).toHaveLength(4);
});
