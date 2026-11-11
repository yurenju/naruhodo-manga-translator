/**
 * migration 0009（#256）：Free Pages 從 50 頁提高到 100 頁，現有的每個 Account 剩下的 Free Pages 都多 50 頁，
 * 包括已經用完（剩 0）與訂閱中的 Account；本月額度的欄位不變。用一個只套到 0008 的空資料庫（MIGRATION_DB）
 * 塞進舊資料再套 0009，migration 沒有 API 看得到，所以直接查 D1。
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;
const before0009 = env.TEST_MIGRATIONS.filter((m) => m.name < '0009');

const NOW = 1_800_000_000_000;

/** 0008 時的額度：還剩一些、剛好用完、訂閱中（Free Pages 不動，本月用了 120 頁）。 */
const OLD_QUOTAS = [
  { account_id: 'free-some-left', free_pages: 30, cycle_start: null, cycle_used: 0 },
  { account_id: 'free-used-up', free_pages: 0, cycle_start: null, cycle_used: 0 },
  { account_id: 'subscribed', free_pages: 12, cycle_start: NOW - 1000, cycle_used: 120 },
];

describe('migration 0009：現有 Account 的 Free Pages 多 50 頁', () => {
  it('每個 Account 都加 50（含剩 0、含訂閱中），本月額度的欄位不變', async () => {
    await applyD1Migrations(db, before0009);
    await db.batch([
      ...OLD_QUOTAS.map((q) => db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').bind(q.account_id, `${q.account_id}@example.com`, NOW)),
      ...OLD_QUOTAS.map((q) =>
        db
          .prepare('INSERT INTO quotas (account_id, free_pages, cycle_start, cycle_used) VALUES (?, ?, ?, ?)')
          .bind(q.account_id, q.free_pages, q.cycle_start, q.cycle_used),
      ),
    ]);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect((await db.prepare('SELECT account_id, free_pages, cycle_start, cycle_used FROM quotas ORDER BY account_id').all()).results).toEqual([
      { account_id: 'free-some-left', free_pages: 80, cycle_start: null, cycle_used: 0 },
      { account_id: 'free-used-up', free_pages: 50, cycle_start: null, cycle_used: 0 },
      { account_id: 'subscribed', free_pages: 62, cycle_start: NOW - 1000, cycle_used: 120 },
    ]);
  });
});
