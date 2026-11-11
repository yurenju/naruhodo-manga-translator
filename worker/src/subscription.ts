/**
 * Subscription（spec #86「額度規則」、#94）：把 Paddle 的 subscription.* webhook 寫進 D1，以及每月週期怎麼算。
 * D1 schema 在 worker/migrations/0003_subscriptions.sql、0010_subscription_billing_period.sql。扣額度在 quota.ts。
 */
import { BILLING_PERIODS, type BillingPeriod } from '../../src/shared/hosted-api.ts';
import { eventHandled, eventOwner, markEventHandled, object, text, time } from './paddle-event.ts';

/** 每個 Billing Period 的 Paddle price id（Worker 的 secret；沒設定是 undefined）。 */
export type PriceIds = Readonly<Record<BillingPeriod, string | undefined>>;

/** 有權限的狀態：active（包含排定取消）與 past_due（Paddle 重試扣款中）。canceled、paused 之後回到只剩 Free Pages。 */
const ENTITLED = ['active', 'past_due'] as const;

export interface Subscription {
  status: (typeof ENTITLED)[number];
  /** 訂閱開始時間：每月週期的錨點。 */
  startedAt: number;
  periodEndsAt: number;
  cancelScheduled: boolean;
  billingPeriod: BillingPeriod;
  /** 下次續訂的金額（美元，含稅）：事件裡 price 的 unit_price；這個欄位之前寫入的訂閱沒有，是 undefined。 */
  renewalPriceUsd: number | undefined;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
}

interface Row {
  status: string;
  started_at: number;
  period_ends_at: number | null;
  cancel_scheduled: number;
  billing_period: BillingPeriod | null;
  renewal_price_cents: number | null;
  paddle_subscription_id: string;
  paddle_customer_id: string;
}

/** SQL 裡的 ENTITLED（常數，不是使用者輸入）。 */
const ENTITLED_SQL = ENTITLED.map((status) => `'${status}'`).join(', ');

const isEntitled = (status: string): status is Subscription['status'] => (ENTITLED as readonly string[]).includes(status);

/** 這個 Account 有權限的訂閱；沒訂閱過、或已經結束就是 undefined。 */
export async function activeSubscription(db: D1Database, accountId: string): Promise<Subscription | undefined> {
  const row = await db.prepare('SELECT * FROM subscriptions WHERE account_id = ?').bind(accountId).first<Row>();
  if (!row || !isEntitled(row.status)) return undefined;
  return {
    status: row.status,
    startedAt: row.started_at,
    // 有權限的訂閱一定有目前的扣款週期；萬一沒有，就當作從開始日起一年
    periodEndsAt: row.period_ends_at ?? addMonths(row.started_at, 12),
    cancelScheduled: row.cancel_scheduled === 1,
    billingPeriod: row.billing_period ?? 'yearly',
    renewalPriceUsd: row.renewal_price_cents === null ? undefined : row.renewal_price_cents / 100,
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleCustomerId: row.paddle_customer_id,
  };
}

/** Paddle 取消訂閱的生效時間（`effective_from`）。 */
export type CancelTiming = 'next_billing_period' | 'immediately';

/**
 * 刪除帳號時要怎麼取消這個 Account 的訂閱；undefined＝不用送（沒訂閱過、已經 canceled、或 active 而且已經排定取消）。
 * - active：到期才失效（已付的這一年照常到期，不退款）
 * - paused：Paddle 只接受立即取消
 * - past_due：排到期末的話，到期前 Paddle 會繼續嘗試扣款，帳號刪了還可能被扣到；這一年本來就還沒付成功，所以立即取消（已排定取消的也一樣）
 */
export async function cancellationOnDelete(db: D1Database, accountId: string): Promise<{ subscriptionId: string; timing: CancelTiming } | undefined> {
  const row = await db
    .prepare('SELECT status, cancel_scheduled, paddle_subscription_id FROM subscriptions WHERE account_id = ?')
    .bind(accountId)
    .first<Pick<Row, 'status' | 'cancel_scheduled' | 'paddle_subscription_id'>>();
  if (!row || row.status === 'canceled') return undefined;
  if (row.status === 'paused' || row.status === 'past_due') return { subscriptionId: row.paddle_subscription_id, timing: 'immediately' };
  return row.cancel_scheduled === 1 ? undefined : { subscriptionId: row.paddle_subscription_id, timing: 'next_billing_period' };
}

/** 這個 Account 的 Paddle customer 與 subscription id（管理訂閱用）；訂閱結束後也還在，才能看收據。 */
export async function paddleIds(db: D1Database, accountId: string): Promise<{ customerId: string; subscriptionId: string } | undefined> {
  const row = await db
    .prepare('SELECT paddle_customer_id, paddle_subscription_id FROM subscriptions WHERE account_id = ?')
    .bind(accountId)
    .first<Pick<Row, 'paddle_customer_id' | 'paddle_subscription_id'>>();
  return row ? { customerId: row.paddle_customer_id, subscriptionId: row.paddle_subscription_id } : undefined;
}

/** anchor 往後 n 個月的同一天同一時刻（UTC）；那個月沒有那一天就是月底。每次都從錨點算，31 號的訂閱 2 月底之後回到 3 月 31 日。 */
function addMonths(anchor: number, n: number): number {
  const d = new Date(anchor);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** now 所在的本月週期：起點與下次重置的時間。週期由開始日自己算，不依賴 Paddle 的扣款週期（一年只扣一次）。 */
export function monthlyCycle(anchor: number, now: number): { start: number; resetsAt: number } {
  const a = new Date(anchor);
  const b = new Date(now);
  let n = Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth());
  if (n > 0 && addMonths(anchor, n) > now) n--;
  return { start: addMonths(anchor, n), resetsAt: addMonths(anchor, n + 1) };
}

/**
 * 訂閱的 item 的 price 是哪一種 Billing Period：季繳的 price 是季繳，其他都當年繳，包括改版前的年繳 US$20
 * （ADR 0012：舊訂閱者續約時改用新的年繳價格）。
 */
function billingPeriodOf(data: Record<string, unknown>, priceIds: PriceIds): BillingPeriod {
  const items = Array.isArray(data.items) ? data.items : [];
  const prices = items.map((item) => text(object(object(item).price).id));
  return BILLING_PERIODS.find((period) => priceIds[period] !== undefined && prices.includes(priceIds[period])) ?? 'yearly';
}

/** 下次續訂的金額（美分）：每個 item 的 price 的 unit_price × quantity 加起來；有任何一個讀不到就是 null（退回定價常數）。 */
function renewalPriceCents(data: Record<string, unknown>): number | null {
  const items = Array.isArray(data.items) ? data.items.map(object) : [];
  const amounts = items.map((item) => Number(text(object(object(item.price).unit_price).amount)) * (typeof item.quantity === 'number' ? item.quantity : 1));
  return items.length > 0 && amounts.every(Number.isInteger) ? amounts.reduce((sum, amount) => sum + amount, 0) : null;
}

/**
 * 套用一個已經驗過簽章的 Paddle 事件。只看 subscription.*，其他事件（transaction.completed 等）不做事。
 * - Account 來自 custom_data.account_id（Worker 建立 transaction 時放的，Paddle 帶到 subscription 上）；沒有的話用 subscription id 找已經存在的那一列
 * - 用 event_id 去重
 * - 每個 Account 只記一筆訂閱（重新訂閱是 Paddle 的另一個 subscription id），哪個事件可以覆蓋目前這一列：
 *   - 同一個 subscription id：用 occurred_at 判斷新舊，比已經套用的事件舊就不覆蓋
 *   - 不同的 subscription id：只有目前這筆沒有權限（paused、canceled）、而且事件的那筆有權限時，才換成那一筆。
 *     所以舊訂閱之後才送來的事件（例如 paused 之後重新訂閱、舊的那筆才被取消）蓋不掉有權限的新訂閱；
 *     新訂閱的事件不看 occurred_at，比舊訂閱最後的事件還早發生也照樣換過去
 * - priceIds：每個 Billing Period 的 Paddle price（Worker 的 secret），用來分辨扣款週期
 */
export async function applyPaddleEvent(db: D1Database, event: unknown, now: number, priceIds: PriceIds): Promise<void> {
  const e = object(event);
  const eventId = text(e.event_id);
  const occurredAt = time(e.occurred_at);
  if (!eventId || occurredAt === undefined || !text(e.event_type)?.startsWith('subscription.')) return;
  if (await eventHandled(db, eventId)) return;

  const data = object(e.data);
  const subscriptionId = text(data.id);
  const customerId = text(data.customer_id);
  const status = text(data.status);
  const startedAt = time(data.started_at) ?? time(object(data.current_billing_period).starts_at) ?? occurredAt;
  if (!subscriptionId || !customerId || !status) return;
  const accountId = await eventOwner(db, text(object(data.custom_data).account_id), subscriptionId);
  if (!accountId) return;

  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (account_id, paddle_subscription_id, paddle_customer_id, status, started_at, period_ends_at, cancel_scheduled, billing_period, renewal_price_cents, event_occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           paddle_subscription_id = excluded.paddle_subscription_id, paddle_customer_id = excluded.paddle_customer_id, status = excluded.status,
           started_at = excluded.started_at, period_ends_at = excluded.period_ends_at, cancel_scheduled = excluded.cancel_scheduled,
           billing_period = excluded.billing_period, renewal_price_cents = excluded.renewal_price_cents, event_occurred_at = excluded.event_occurred_at
         WHERE (excluded.paddle_subscription_id = subscriptions.paddle_subscription_id AND excluded.event_occurred_at > subscriptions.event_occurred_at)
            OR (excluded.paddle_subscription_id <> subscriptions.paddle_subscription_id
                AND subscriptions.status NOT IN (${ENTITLED_SQL}) AND excluded.status IN (${ENTITLED_SQL}))`,
      )
      .bind(
        accountId,
        subscriptionId,
        customerId,
        status,
        startedAt,
        time(object(data.current_billing_period).ends_at) ?? null,
        text(object(data.scheduled_change).action) === 'cancel' ? 1 : 0,
        billingPeriodOf(data, priceIds),
        renewalPriceCents(data),
        occurredAt,
      ),
    markEventHandled(db, eventId, now),
  ]);
}
