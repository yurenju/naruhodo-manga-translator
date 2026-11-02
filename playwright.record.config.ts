import { defineConfig } from '@playwright/test';

// 錄 FakeEngine 重播的結果（ADR 0007）：真模型跑合成頁，寫進 testdata/synthetic/recorded-ocr.json。`npm run record:ocr`。
// 同一個指令也錄 Practice Spread 的原文（#169，practice-spread/ocr.json），要先 `npm run site:build`。
export default defineConfig({
  testDir: 'browser',
  testMatch: ['record-ocr.spec.ts', 'record-practice-spread.spec.ts'],
  globalSetup: './browser/global-setup.ts',
  workers: 1,
  reporter: [['list']],
});
