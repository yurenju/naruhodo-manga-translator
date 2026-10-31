/**
 * 額度（spec #86「額度規則」、#92、#94）：新 Account 有一次性的 Free Pages；訂閱中（subscription.ts）只扣本月的 Monthly Page Limit，
 * Free Pages 不動，訂閱結束後剩下的照常可用。D1 schema 在 worker/migrations/0002_free_pages.sql、0003_subscriptions.sql。
 */
import { FREE_PAGES, type Quota } from '../../src/shared/hosted-api.ts';
import type { Usage } from '../../src/shared/translator.ts';
import { sha256 } from './hash.ts';
import { activeSubscription, monthlyCycle } from './subscription.ts';

/** 算額度要的：現在時間與 Monthly Page Limit（Worker 的設定值）。 */
export interface QuotaContext {
  now: number;
  limit: number;
}

/** wrangler.jsonc 的 MONTHLY_PAGE_LIMIT。 */
export const monthlyLimit = (env: Cloudflare.Env): number => Number(env.MONTHLY_PAGE_LIMIT);

/** 新 Account 的 Free Pages：這個 email 沒領過才給 FREE_PAGES 頁，領過（刪除帳號後重新註冊）就是 0。 */
export async function grantFreePages(db: D1Database, accountId: string, email: string, now: number): Promise<void> {
  const grant = await db.prepare('INSERT INTO free_page_grants (email_hash, granted_at) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(await sha256(email), now).run();
  await db.prepare('INSERT INTO quotas (account_id, free_pages) VALUES (?, ?)').bind(accountId, grant.meta.changes === 1 ? FREE_PAGES : 0).run();
}

export async function quota(db: D1Database, accountId: string, { now, limit }: QuotaContext): Promise<Quota> {
  const [row, subscription] = await Promise.all([
    db.prepare('SELECT free_pages, cycle_start, cycle_used FROM quotas WHERE account_id = ?').bind(accountId).first<{ free_pages: number; cycle_start: number | null; cycle_used: number }>(),
    activeSubscription(db, accountId),
  ]);
  if (!subscription) return { plan: 'free', remaining: row?.free_pages ?? 0 };
  const cycle = monthlyCycle(subscription.startedAt, now);
  // 存的週期起點不是現在這個週期＝已經重置，本月還沒用
  const used = row?.cycle_start === cycle.start ? row.cycle_used : 0;
  return {
    plan: 'subscribed',
    remaining: Math.max(0, limit - used),
    limit,
    resetsAt: cycle.resetsAt,
    status: subscription.status === 'past_due' ? 'pastDue' : 'active',
    cancelScheduled: subscription.cancelScheduled,
    periodEndsAt: subscription.periodEndsAt,
  };
}

/**
 * 扣一個 Translated Page：訂閱中扣本月額度，否則扣 Free Pages。條件式 UPDATE 一次做完「還有沒有、扣掉」，不先讀再寫；
 * false＝已經沒有了。本月額度那一句同時處理重置：存的週期起點不是現在的週期，就從 1 重新算。
 */
export async function deductPage(db: D1Database, accountId: string, { now, limit }: QuotaContext): Promise<boolean> {
  const subscription = await activeSubscription(db, accountId);
  const result = subscription
    ? await db
        .prepare(
          `UPDATE quotas SET cycle_used = CASE WHEN cycle_start = ?1 THEN cycle_used + 1 ELSE 1 END, cycle_start = ?1
           WHERE account_id = ?2 AND (cycle_start IS NOT ?1 OR cycle_used < ?3) AND ?3 > 0`,
        )
        .bind(monthlyCycle(subscription.startedAt, now).start, accountId, limit)
        .run()
    : await db.prepare('UPDATE quotas SET free_pages = free_pages - 1 WHERE account_id = ? AND free_pages > 0').bind(accountId).run();
  return result.meta.changes === 1;
}

export type UsageKind = 'translate' | 'notes';

/** 長 Page 的接續翻譯（spec #142「計費」）：第一次翻譯之後多久內、最多幾次接續不扣頁。 */
export const CONTINUATION_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CONTINUATIONS = 10;

/**
 * 翻譯紀錄 ?2 能不能被這個 Account（?1）在 ?3 這時接續：是自己扣過頁的那次翻譯（本身不是接續）、在 1 小時內、接續還沒滿 10 次。
 * 用在子查詢裡，條件跟寫入在同一句，同時送來的接續請求不會一起超過上限。
 */
const CONTINUABLE = `SELECT id FROM usage_records WHERE id = ?2 AND account_id = ?1 AND kind = 'translate' AND page_record_id IS NULL
  AND created_at >= ?3 - ${CONTINUATION_WINDOW_MS}
  AND (SELECT count(*) FROM usage_records WHERE page_record_id = ?2 AND kind = 'translate') < ${MAX_CONTINUATIONS}`;

/** 送出前看：這個接續請求在條件內嗎（額度用完時，條件內的接續照樣翻）。 */
export async function continuable(db: D1Database, accountId: string, pageRecordId: number, now: number): Promise<boolean> {
  return (await db.prepare(CONTINUABLE).bind(accountId, pageRecordId, now).first()) !== null;
}

/**
 * 一次 Anthropic 呼叫的用量：只有時間、種類、tokens 與成本，不存任何內容；回傳這筆紀錄的 id 與它歸屬的翻譯紀錄。
 * pageRecordId 是 client 帶來的同一頁的翻譯紀錄 id，條件不符就當作沒帶（歸屬是 undefined）：
 * - Notes：是這個 Account 的翻譯紀錄才記。
 * - 翻譯（長 Page 的接續）：要能接續（CONTINUABLE）才記；記了就是不扣頁的接續。
 */
export async function recordUsage(
  db: D1Database,
  accountId: string,
  kind: UsageKind,
  usage: Usage,
  now: number,
  pageRecordId?: number,
): Promise<{ id: number; pageRecordId?: number }> {
  const page = kind === 'translate' ? CONTINUABLE : `SELECT id FROM usage_records WHERE id = ?2 AND account_id = ?1 AND kind = 'translate'`;
  const row = await db
    .prepare(
      `INSERT INTO usage_records (account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd, page_record_id)
       VALUES (?1, ?3, ?4, ?5, ?6, ?7, ?8, (${page}))
       RETURNING id, page_record_id`,
    )
    .bind(accountId, pageRecordId ?? null, now, kind, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.costUsd)
    .first<{ id: number; page_record_id: number | null }>();
  return { id: row!.id, ...(row!.page_record_id === null ? {} : { pageRecordId: row!.page_record_id }) };
}

/** 開發用：直接設定這個 email 的 Account 的免費額度；沒有這個 Account 就是 false。 */
export async function setFreePages(db: D1Database, email: string, remaining: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE quotas SET free_pages = ? WHERE account_id = (SELECT id FROM accounts WHERE email = ?)')
    .bind(remaining, email)
    .run();
  return result.meta.changes === 1;
}
