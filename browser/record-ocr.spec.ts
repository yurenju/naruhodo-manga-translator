/**
 * 錄 FakeEngine 重播的結果（ADR 0007）：真模型對每張合成頁（Spread 再加上每一頁）跑一次，存成 testdata/synthetic/recorded-ocr.json。
 * 換模型或改到偵測／OCR 時重錄：`npm run record:ocr`（playwright.record.config.ts）。browser test 與 e2e 都不跑這個檔案。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readGroundTruth, SYNTHETIC_IDS } from '../src/testing/synthetic.ts';
import type { RecordedOcr } from '../src/offscreen/fake-engine.ts';
import { E2E_PIPELINE, test } from './fixtures.ts';

const SYNTHETIC = new URL('../testdata/synthetic/out/', import.meta.url);
const OUTPUT = new URL('../testdata/synthetic/recorded-ocr.json', import.meta.url);

test('錄下真模型在合成頁上的結果', async ({ context, extensionId, mockSite }) => {
  test.setTimeout(5 * 60_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test-pipeline.html`);
  const config = E2E_PIPELINE(mockSite);

  const recorded: RecordedOcr[] = [];
  for (const id of SYNTHETIC_IDS) {
    const gt = readGroundTruth(id);
    const dataUrl = `data:image/png;base64,${(await readFile(new URL(`${id}.png`, SYNTHETIC))).toString('base64')}`;
    // 整張圖，Spread 再加上每一頁（外掛會把 Spread 切開，各頁分別送進流水線）
    const rects = [[0, 0, gt.width, gt.height] as const, ...(gt.pages.length > 1 ? gt.pages.map((p) => p.bbox) : [])];
    for (const [x, y, width, height] of rects) {
      const { text } = await page.evaluate(([url, config, rect]) => globalThis.__analyzeImage(url, config, rect), [dataUrl, config, { x, y, width, height }] as const);
      recorded.push({
        id,
        rect: [x, y, width, height],
        balloons: text.balloons.map(({ balloonBbox, textBbox, 原文, ocrConfidence }) => ({ balloonBbox, textBbox, 原文, ocrConfidence })),
        looseText: text.looseText.map(({ bbox, 原文, ocrConfidence }) => ({ bbox, 原文, ocrConfidence })),
      });
      console.log(`${id} [${x}, ${y}, ${width}, ${height}]：${text.balloons.length} 個 Balloon、${text.looseText.length} 段 Loose Text`);
    }
  }
  await writeFile(OUTPUT, `${JSON.stringify(recorded, null, 2)}\n`);
});
