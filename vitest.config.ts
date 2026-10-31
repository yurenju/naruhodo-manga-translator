import { defineConfig } from 'vitest/config';

export default defineConfig({
  // build 時的常數（scripts/build.ts）；單元測試當正式 build
  define: { __E2E__: 'false', __DEBUG__: 'false', __HOSTED_API_URL__: '""' },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'site/src/**/*.test.ts'] },
      },
      // Worker 的 HTTP 測試在 workerd 裡跑（worker/vitest.config.ts）
      'worker/vitest.config.ts',
    ],
  },
});
