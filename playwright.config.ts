import { defineConfig } from '@playwright/test';
import type { TestOptions } from './browser/fixtures.ts';

// browser test（ADR 0007）：真的瀏覽器與外掛，OCR 用 FakeEngine、LLM 用 FakeTranslator，不下載模型。
// 外掛從 dist/e2e 載入，先跑 `npm run build:e2e`（`npm run test:browser` 會自動做）。
// 標 @e2e 的測試在這裡也跑（用 FakeEngine），playwright.e2e.config.ts 再用真的 OCR 跑一次；只對真模型有意義的會自己 skip。
// 呼叫真的 API 的在 playwright.smoke.config.ts；碰真的 Paddle sandbox 的在 playwright.smoke-paddle.config.ts。
export default defineConfig<TestOptions>({
  testDir: 'browser',
  // 錄 FakeEngine 重播結果的在 playwright.record.config.ts
  testIgnore: ['smoke/**', 'smoke-paddle/**', 'record-ocr.spec.ts', 'record-practice-spread.spec.ts'],
  // Hosted Translation 的本機 Worker（wrangler dev，約 2 秒）；e2e build 連它
  globalSetup: './browser/worker-setup.ts',
  // 每個 test 各自開 Chromium context 與 mock site，同一個檔案的測試也能分到不同 worker
  fullyParallel: true,
  // FakeEngine 幾乎不花時間：測試不設更長的 timeout，失敗時很快就紅；真 OCR 的放寬在 playwright.e2e.config.ts
  timeout: 30_000,
  // 8 個瀏覽器同時跑時，啟動到第一次覆蓋偶爾超過 expect 預設的 5 秒
  expect: { timeout: 10_000 },
  // FakeEngine 是確定性的：重跑才過代表程式本身有 race condition，直接紅
  retries: 0,
  use: { fakeOcr: true },
  reporter: [['list']],
});
