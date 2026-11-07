declare namespace Cloudflare {
  interface Env {
    /** 只有測試有：vitest.config.ts 讀好的 worker/migrations。 */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    /** 只有測試有：migration 的測試用的空資料庫（vitest.config.ts），不會自動套用 migrations。 */
    MIGRATION_DB: D1Database;
  }
}
