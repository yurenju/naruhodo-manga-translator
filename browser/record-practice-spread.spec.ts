/**
 * 錄 Worker 認 Practice Spread 用的原文（#169）：在 site/dist 的試翻頁上用真的模型跑整條外掛流程，記下送給 Translator 的每一頁原文，
 * 存成 practice-spread/ocr.json。wasm 與 WebGPU 各跑一次、各兩種視窗大小（讀者的螢幕大小不一，OCR 的結果會有一點差異）。
 * 換 Practice Spread 的圖、換模型或改到偵測／OCR 時重錄：`npm run site:build && npm run record:ocr`。
 * WebGPU 從真的 Hugging Face 下載 fp32 那組（約 472 MB）；機器沒有 WebGPU adapter 就只錄 wasm。
 */
import { writeFile } from 'node:fs/promises';
import type { Message, ModelStatusResponse, TestConfig } from '../src/shared/messages.ts';
import type { ExecutionProvider } from '../src/shared/messages.ts';
import type { PracticeSpreadText } from '../src/shared/practice-spread.ts';
import { launchWithExtension, openSidePanel, tabIdOf, test, testActivate } from './fixtures.ts';
import { startSiteServer } from './site-server.ts';

const OUTPUT = new URL('../practice-spread/ocr.json', import.meta.url);

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1920, height: 1080 },
];

test('錄下真模型在試翻頁上辨識出的原文', async ({ mockSite }) => {
  test.setTimeout(30 * 60_000);
  const site = await startSiteServer();
  const recorded: PracticeSpreadText = {};
  try {
    for (const executionProvider of ['wasm', 'webgpu'] satisfies ExecutionProvider[]) {
      for (const viewport of VIEWPORTS) {
        const context = await launchWithExtension('');
        try {
          const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
          // wasm 用 mock site 提供的模型快取；WebGPU 那組不在快取裡，從 Hugging Face 下載
          const pipeline = executionProvider === 'wasm' ? { modelBaseUrl: mockSite.modelBaseUrl, executionProvider } : { executionProvider };
          await sw.evaluate((config) => globalThis.__configureForTest!(config), { pipeline, fakeTranslator: true } satisfies TestConfig);

          const page = await context.newPage();
          await page.setViewportSize(viewport);
          const url = `${site.origin}/zh-tw/try/?shot`;
          await page.goto(url);
          await page.locator('.spread img').evaluate((img: HTMLImageElement) => img.decode());
          if (executionProvider === 'webgpu' && !(await page.evaluate(async () => Boolean(await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter())))) {
            console.log('這台機器沒有 WebGPU adapter，略過 WebGPU');
            break;
          }
          const tabId = await tabIdOf(sw, url);
          const panel = await openSidePanel(context, (new URL(sw.url())).host, tabId);
          await page.bringToFront();
          await testActivate(panel, tabId);

          await test.expect
            .poll(() => sw.evaluate(() => globalThis.__translateInputs?.length ?? 0), { timeout: 20 * 60_000, intervals: [2000] })
            .toBeGreaterThanOrEqual(2);
          const { status } = await panel.evaluate((message) => chrome.runtime.sendMessage<Message, ModelStatusResponse>(message), { type: 'panel:getModelStatus' } satisfies Message);
          // WebGPU 建 session 失敗會退回 wasm：照實際跑的記
          const ran = status.state === 'ready' ? status.executionProvider : executionProvider;
          const inputs = await sw.evaluate(() => globalThis.__translateInputs!);
          const key = `${ran}@${viewport.width}x${viewport.height}`;
          recorded[key] = inputs.map((input) => input.items.map((item) => item.原文));
          console.log(`${key}：${recorded[key].map((p) => `${p.length} 句`).join('、')}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await site.close();
  }
  await writeFile(OUTPUT, `${JSON.stringify(recorded, null, 2)}\n`);
});
