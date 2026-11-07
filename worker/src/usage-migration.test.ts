/**
 * migration 0007（#238）重建 usage_records：套到已經有資料的資料庫上，原有的列（id、page_record_id 在內）都不變，
 * 長 Page 能不能接續（quota.ts 的 continuable）也不變。用一個只套到 0006 的空資料庫（MIGRATION_DB）塞進舊資料再套 0007，
 * migration 沒有 API 看得到，所以直接查 D1。
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL } from '../../src/shared/claude-request.ts';
import { continuable } from './quota.ts';

const db = env.MIGRATION_DB;
const before0007 = env.TEST_MIGRATIONS.filter((m) => m.name < '0007');

const NOW = 1_800_000_000_000;
const A = 'account-a';
const B = 'account-b';

/** 0006 時的欄位：沒有 cache_write_tokens、model，kind 只有 translate／notes。 */
const OLD_ROWS = [
  // 3 被刪掉過（以前刪帳號會刪用量紀錄），id 有缺號
  { id: 1, account_id: A, created_at: NOW - 1000, kind: 'translate', input_tokens: 1000, output_tokens: 200, cache_read_tokens: 700, cost_usd: 0.000137, page_record_id: null, practice: 0 },
  { id: 2, account_id: A, created_at: NOW - 900, kind: 'notes', input_tokens: 500, output_tokens: 80, cache_read_tokens: 0, cost_usd: 0.0001, page_record_id: 1, practice: 0 },
  { id: 4, account_id: A, created_at: NOW - 800, kind: 'translate', input_tokens: 900, output_tokens: 100, cache_read_tokens: 700, cost_usd: 0.00012, page_record_id: 1, practice: 0 },
  { id: 5, account_id: B, created_at: NOW - 700, kind: 'translate', input_tokens: 800, output_tokens: 100, cache_read_tokens: 0, cost_usd: 0.00013, page_record_id: null, practice: 1 },
  { id: 6, account_id: B, created_at: NOW - 2 * 60 * 60 * 1000, kind: 'translate', input_tokens: 800, output_tokens: 100, cache_read_tokens: 0, cost_usd: 0.00013, page_record_id: null, practice: 0 },
];

/** 每一筆紀錄在 NOW 時能不能被它的 Account（以及另一個 Account）接續。 */
const continuability = () =>
  Promise.all(OLD_ROWS.flatMap((row) => [A, B].map(async (account) => [row.id, account, await continuable(db, account, row.id, NOW)])));

const rows = async () => (await db.prepare('SELECT * FROM usage_records ORDER BY id').all()).results;

describe('migration 0007：重建 usage_records', () => {
  it('原有的列、id、page_record_id 都不變，新欄位是 NULL；接續的判斷不變；之後可以寫 series_guess 與沒有 Account 的紀錄', async () => {
    await applyD1Migrations(db, before0007);
    await db.batch([
      ...[A, B].map((id) => db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').bind(id, `${id}@example.com`, NOW)),
      ...OLD_ROWS.map((r) =>
        db
          .prepare(
            `INSERT INTO usage_records (id, account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd, page_record_id, practice)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(r.id, r.account_id, r.created_at, r.kind, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cost_usd, r.page_record_id, r.practice),
      ),
    ]);
    const continuableBefore = await continuability();
    // 0006 的資料本身要有能接續、也有不能接續的，比較才有意義
    expect(continuableBefore.filter(([, , ok]) => ok)).toEqual([[1, A, true]]);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(await rows()).toEqual(OLD_ROWS.map((r) => ({ ...r, cache_write_tokens: null, model: null })));
    expect(await continuability()).toEqual(continuableBefore);
    const inserted = await db
      .prepare(
        `INSERT INTO usage_records (account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model)
         VALUES (NULL, ?, 'series_guess', 1, 1, 0, 0, 0, ?) RETURNING id`,
      )
      .bind(NOW, CLAUDE_MODEL)
      .first<{ id: number }>();
    expect(inserted!.id).toBe(7);
  });
});
