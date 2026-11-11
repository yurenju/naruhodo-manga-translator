import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// Worker 的 HTTP 測試（spec #86 接縫一）：在 workerd 裡跑真正的 Worker 與本機 D1，Anthropic 用 vi.spyOn(fetch) 假的。
// 用 env.dev（真的 Claude 與 Paddle 路徑），key 換成假的，萬一沒攔到 fetch 也只會拿到 401；Paddle 的網址是不存在的 paddle.test。
// 寄信是 env.dev 的假實作（FAKE_MAIL）。webhook 的 secret 與 test/paddle.ts 簽章用的是同一個。
// migrations 在 Node 這邊讀出來，交給 setup 檔在每個測試檔開始前套用。
const migrations = await readD1Migrations(join(dirname(fileURLToPath(import.meta.url)), 'migrations'));

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          CLAUDE_API_KEY: 'sk-ant-worker-test',
          // Monthly Page Limit 是設定值：測試設成 3 頁，「本月額度用完」不用翻 3,000 頁
          MONTHLY_PAGE_LIMIT: '3',
          PADDLE_API_KEY: 'pdl_sdbx_apikey_worker_test',
          PADDLE_API_BASE_URL: 'https://paddle.test',
          PADDLE_PRICE_ID_QUARTERLY: 'pri_worker_test_quarterly',
          PADDLE_PRICE_ID_YEARLY: 'pri_worker_test_yearly',
          PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_worker_test',
          TEST_MIGRATIONS: migrations,
        },
        // migration 的測試用：跟 DB 分開的空資料庫，測試自己決定套到哪一個 migration
        d1Databases: ['MIGRATION_DB'],
      },
    }),
  ],
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/apply-migrations.ts'],
  },
});
