/**
 * 額度（spec #86「額度規則」、#92、#94）：新 Account 有一次性的 Free Pages；訂閱中（subscription.ts）只扣本月的 Monthly Page Limit，
 * Free Pages 不動，訂閱結束後剩下的照常可用。D1 schema 在 worker/migrations/0002_free_pages.sql、0003_subscriptions.sql。
 */
import { FREE_PAGES, type Quota } from '../../src/shared/hosted-api.ts';
import type { CallInfo } from '../../src/shared/translator.ts';
import { sha256 } from './hash.ts';
import { activeSubscription, monthlyCycle } from './subscription.ts';

/** 算額度要的：現在時間與 Monthly Page Limit（Worker 的設定值）。 */
export interface QuotaContext {
  now: number;
  limit: number;
}

/** wrangler.jsonc 的 MONTHLY_PAGE_LIMIT。 */
export const monthlyLimit = (env: Cloudflare.Env): number => Number(env.MONTHLY_PAGE_LIMIT);

/** wrangler.jsonc 的 DAILY_FREE_PAGES_CAP：Daily Free Pages Cap（#241）。 */
export const dailyFreePagesCap = (env: Cloudflare.Env): number => Number(env.DAILY_FREE_PAGES_CAP);

/** Daily Free Pages Cap 算的那一天：UTC 的 YYYY-MM-DD，UTC 0 點換下一天。 */
const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** 今天（UTC）全站送出的 Free Pages 到了 cap 沒（#241）。到了，只靠 Free Pages 的 Account 今天剩下的時間不再送 Anthropic。 */
export async function freePagesPausedToday(db: D1Database, now: number, cap: number): Promise<boolean> {
  const row = await db.prepare('SELECT used FROM daily_free_pages WHERE day = ?').bind(utcDay(now)).first<{ used: number }>();
  return (row?.used ?? 0) >= cap;
}

/** 開發用：直接設定今天（UTC）全站已送出的 Free Pages。 */
export async function setDailyFreePages(db: D1Database, now: number, used: number): Promise<void> {
  await db
    .prepare('INSERT INTO daily_free_pages (day, used) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET used = ?2')
    .bind(utcDay(now), used)
    .run();
}

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
 * 扣到 Free Pages 也算進今天全站的總數（Daily Free Pages Cap，#241）。這裡不看上限（送出前已經看過）：同時送來的請求
 * 可能讓當天超出幾頁，可以接受；超出之後送出前的檢查就會擋，不會一直超過下去。
 */
export async function deductPage(db: D1Database, accountId: string, { now, limit }: QuotaContext): Promise<boolean> {
  const subscription = await activeSubscription(db, accountId);
  if (subscription) {
    const result = await db
      .prepare(
        `UPDATE quotas SET cycle_used = CASE WHEN cycle_start = ?1 THEN cycle_used + 1 ELSE 1 END, cycle_start = ?1
         WHERE account_id = ?2 AND (cycle_start IS NOT ?1 OR cycle_used < ?3) AND ?3 > 0`,
      )
      .bind(monthlyCycle(subscription.startedAt, now).start, accountId, limit)
      .run();
    return result.meta.changes === 1;
  }
  const result = await db.prepare('UPDATE quotas SET free_pages = free_pages - 1 WHERE account_id = ? AND free_pages > 0').bind(accountId).run();
  if (result.meta.changes !== 1) return false;
  await db
    .prepare('INSERT INTO daily_free_pages (day, used) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET used = used + 1')
    .bind(utcDay(now))
    .run();
  return true;
}

/** series_guess：猜作品原名（#186），不扣頁、不屬於任何一頁。 */
export type UsageKind = 'translate' | 'notes' | 'series_guess';

/** 長 Page 的接續翻譯（spec #142「計費」）：第一次翻譯之後多久內、最多幾次接續不扣頁。 */
export const CONTINUATION_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CONTINUATIONS = 10;

/**
 * 翻譯紀錄 ?2 能不能被這個 Account（?1）在 ?3 這時接續：是自己扣過頁的那次翻譯（本身不是接續、也不是不扣頁的試翻）、在 1 小時內、接續還沒滿 10 次。
 * 用在子查詢裡，條件跟寫入在同一句，同時送來的接續請求不會一起超過上限。
 */
const CONTINUABLE = `SELECT id FROM usage_records WHERE id = ?2 AND account_id = ?1 AND kind = 'translate' AND page_record_id IS NULL AND practice = 0
  AND created_at >= ?3 - ${CONTINUATION_WINDOW_MS}
  AND (SELECT count(*) FROM usage_records WHERE page_record_id = ?2 AND kind = 'translate') < ${MAX_CONTINUATIONS}`;

/** 送出前看：這個接續請求在條件內嗎（額度用完時，條件內的接續照樣翻）。 */
export async function continuable(db: D1Database, accountId: string, pageRecordId: number, now: number): Promise<boolean> {
  return (await db.prepare(CONTINUABLE).bind(accountId, pageRecordId, now).first()) !== null;
}

/**
 * 一次 Anthropic 呼叫的用量：只有時間、種類、tokens、成本與模型，不存任何內容；回傳這筆紀錄的 id 與它歸屬的翻譯紀錄。
 * pageRecordId 是 client 帶來的同一頁的翻譯紀錄 id，條件不符就當作沒帶（歸屬是 undefined）：
 * - Notes：是這個 Account 的翻譯紀錄才記。
 * - 翻譯（長 Page 的接續）：要能接續（CONTINUABLE）才記；記了就是不扣頁的接續。
 * - 猜作品原名：不屬於任何一頁，呼叫端不帶。
 * practice：Practice Spread 的翻譯（#169），不扣頁、不算進任何額度。
 */
export async function recordUsage(
  db: D1Database,
  accountId: string,
  kind: UsageKind,
  { usage, model }: Pick<CallInfo, 'usage' | 'model'>,
  now: number,
  pageRecordId?: number,
  practice = false,
): Promise<{ id: number; pageRecordId?: number }> {
  const page = kind === 'translate' ? CONTINUABLE : `SELECT id FROM usage_records WHERE id = ?2 AND account_id = ?1 AND kind = 'translate'`;
  const row = await db
    .prepare(
      `INSERT INTO usage_records (account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model, page_record_id, practice)
       VALUES (?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, (${page}), ?11)
       RETURNING id, page_record_id`,
    )
    // ?1～?3 的位置由 CONTINUABLE 決定；其餘照欄位順序
    .bind(
      accountId,
      pageRecordId ?? null,
      now,
      kind,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens ?? null,
      usage.costUsd,
      model,
      practice ? 1 : 0,
    )
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
