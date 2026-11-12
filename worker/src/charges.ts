/**
 * 成功的扣款與 Refund Window（#260，ADR 0012：每次扣款後 14 天內可以全額退款，不看用量）。
 * Paddle 的 transaction.completed webhook 寫進 D1 的 charges（worker/migrations/0011_charges.sql）；GET /v1/account 的 refund
 * 與退款 API 都從最近一次扣款算。Paddle 核准或拒絕退款（adjustment 的 webhook）也記在 charges：refundOutcome（#261）。
 */
import { REFUND_WINDOW_DAYS, type RefundInfo, type RefundRefusal, type RefundStatus } from '../../src/shared/hosted-api.ts';
import { sha256 } from './hash.ts';
import { eventHandled, eventOwner, markEventHandled, object, text, time } from './paddle-event.ts';
import { activeSubscription, type Subscription } from './subscription.ts';

const REFUND_WINDOW_MS = REFUND_WINDOW_DAYS * 24 * 60 * 60_000;

interface Row {
  transaction_id: string;
  paddle_subscription_id: string;
  billed_at: number;
  amount_cents: number;
  refund_status: 'pending' | 'approved' | 'rejected' | null;
}

/** D1 存的是 Paddle adjustment 的字（approved），API 用讀者看得懂的 refunded；D1 已存的值不改，在這裡轉。 */
const STATUS: Record<NonNullable<Row['refund_status']> | 'none', RefundStatus> = { none: 'none', pending: 'pending', approved: 'refunded', rejected: 'rejected' };

/**
 * 套用一個已經驗過簽章的 transaction.completed：記下這次扣款（transaction id、扣款時間、實付金額）。其他事件不做事。
 * - Account：首購的 transaction 帶 custom_data.account_id（Worker 建立 transaction 時放的）；續約的用 subscription id 找已經存在的訂閱
 * - 不屬於訂閱的 transaction 不記；同一個 transaction 只記一次，event_id 去重
 */
export async function applyChargeEvent(db: D1Database, event: unknown, now: number): Promise<void> {
  const e = object(event);
  const eventId = text(e.event_id);
  if (!eventId || text(e.event_type) !== 'transaction.completed') return;
  if (await eventHandled(db, eventId)) return;
  const data = object(e.data);
  const transactionId = text(data.id);
  const subscriptionId = text(data.subscription_id);
  const billedAt = time(data.billed_at) ?? time(e.occurred_at);
  const totals = object(object(data.details).totals);
  const amountCents = Number(text(totals.grand_total) ?? text(totals.total));
  if (!transactionId || !subscriptionId || billedAt === undefined || !Number.isInteger(amountCents)) return;
  const accountId = await eventOwner(db, text(object(data.custom_data).account_id), subscriptionId);
  if (!accountId) return;
  await db.batch([
    db
      .prepare('INSERT INTO charges (transaction_id, account_id, paddle_subscription_id, billed_at, amount_cents) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(transactionId, accountId, subscriptionId, billedAt, amountCents),
    markEventHandled(db, eventId, now),
  ]);
}

const latestCharge = (db: D1Database, accountId: string) =>
  db
    .prepare('SELECT transaction_id, paddle_subscription_id, billed_at, amount_cents, refund_status FROM charges WHERE account_id = ? ORDER BY billed_at DESC LIMIT 1')
    .bind(accountId)
    .first<Row>();

/** 這個 Account 的 email 退款過（refunded_emails，刪除帳號後仍保留）。 */
async function emailRefundedBefore(db: D1Database, accountId: string): Promise<boolean> {
  const account = await db.prepare('SELECT email FROM accounts WHERE id = ?').bind(accountId).first<{ email: string }>();
  if (!account) return false;
  return (await db.prepare('SELECT 1 FROM refunded_emails WHERE email_hash = ?').bind(await sha256(account.email)).first()) !== null;
}

/** 算 refusal 要的：最近一次扣款、它的訂閱，以及這個 email 退款過沒。 */
interface RefundState {
  charge: Row | null;
  subscription: Subscription | undefined;
  refundedBefore: boolean;
}

async function refundState(db: D1Database, accountId: string): Promise<RefundState> {
  const [charge, subscription, refundedBefore] = await Promise.all([latestCharge(db, accountId), activeSubscription(db, accountId), emailRefundedBefore(db, accountId)]);
  return { charge, subscription, refundedBefore };
}

/**
 * 最近一次扣款能不能退款；undefined＝可以。先看退款狀態（申請過就不能再申請），再看訂閱：那筆扣款的訂閱要還有權限
 * （排定取消也算，退款期看的是扣款日）、不是扣款失敗重試中；再看金額與 Refund Window。
 * 其他都符合才看 email 退款過沒（ADR 0012）：refundByEmail＝這次要寫信，所以只在原本能申請時出現。
 */
function refusal({ charge, subscription, refundedBefore }: RefundState & { charge: Row }, now: number): RefundRefusal | undefined {
  if (charge.refund_status === 'pending') return 'refundPending';
  if (charge.refund_status === 'rejected') return 'refundRejected';
  if (charge.refund_status === 'approved') return 'refundRefunded';
  if (subscription?.paddleSubscriptionId !== charge.paddle_subscription_id) return 'refundNoCharge';
  if (subscription.status === 'past_due') return 'refundPastDue';
  if (charge.amount_cents <= 0) return 'refundZeroAmount';
  if (now >= charge.billed_at + REFUND_WINDOW_MS) return 'refundWindowClosed';
  if (refundedBefore) return 'refundByEmail';
  return undefined;
}

/** GET /v1/account 的退款資訊：最近一次扣款；沒有成功扣款過是 undefined。 */
export async function refundInfo(db: D1Database, accountId: string, now: number): Promise<RefundInfo | undefined> {
  const state = await refundState(db, accountId);
  const { charge } = state;
  if (!charge) return undefined;
  const windowEndsAt = charge.billed_at + REFUND_WINDOW_MS;
  const reason = refusal({ ...state, charge }, now);
  return {
    billedAt: charge.billed_at,
    amountUsd: charge.amount_cents / 100,
    windowEndsAt,
    inWindow: now < windowEndsAt,
    status: STATUS[charge.refund_status ?? 'none'],
    eligible: reason === undefined,
    byEmail: reason === 'refundByEmail',
  };
}

/**
 * 退款 API 的第一步：最近一次扣款可以退就把它記為處理中，回傳 transaction id；不能退回原因。
 * 條件式 UPDATE（只有還沒申請過的才改），同時送來的兩個請求只有一個拿得到，不會建立兩筆退款。
 */
export async function claimRefund(db: D1Database, accountId: string, now: number): Promise<{ ok: true; transactionId: string } | { ok: false; reason: RefundRefusal }> {
  const state = await refundState(db, accountId);
  const { charge } = state;
  if (!charge) return { ok: false, reason: 'refundNoCharge' };
  const reason = refusal({ ...state, charge }, now);
  if (reason) return { ok: false, reason };
  const claimed = await db
    .prepare("UPDATE charges SET refund_status = 'pending' WHERE transaction_id = ? AND refund_status IS NULL")
    .bind(charge.transaction_id)
    .run();
  return claimed.meta.changes === 1 ? { ok: true, transactionId: charge.transaction_id } : { ok: false, reason: 'refundPending' };
}

/** Paddle 建好退款：記下 adjustment id（核准、被拒的 webhook 對得到這筆）。 */
export async function recordRefundAdjustment(db: D1Database, transactionId: string, adjustmentId: string): Promise<void> {
  await db.prepare('UPDATE charges SET refund_adjustment_id = ? WHERE transaction_id = ?').bind(adjustmentId, transactionId).run();
}

/** Paddle 建立退款失敗：放掉處理中，讀者可以再按一次。 */
export async function releaseRefund(db: D1Database, transactionId: string): Promise<void> {
  await db.prepare("UPDATE charges SET refund_status = NULL WHERE transaction_id = ? AND refund_status = 'pending' AND refund_adjustment_id IS NULL").bind(transactionId).run();
}

/**
 * Paddle 對一筆全額退款的結果（adjustment.created／adjustment.updated）。cancel＝要立即取消訂閱。
 * Paddle 核准退款並不會取消訂閱（sandbox 實測：訂閱照樣 active、到期還會續約），所以核准時 Worker 自己取消（REFUND.md：退款的訂閱會被取消）。
 */
export interface RefundOutcome {
  eventId: string;
  adjustmentId: string;
  transactionId: string;
  subscriptionId: string;
  status: 'approved' | 'rejected';
  cancel: boolean;
}

/**
 * 從一個已經驗過簽章的事件讀出退款結果；undefined＝不是要處理的事件，包括處理過的事件。處理完要 recordRefundOutcome。
 * - adjustment.created 與 adjustment.updated 都看：API 建立、自動核准的退款可能建立時就是 approved、只送 adjustment.created
 *   （Paddle 文件前後不一致，#261）；還在等核准（pending_approval）的不處理
 * - 全額才算：最上層 type 是 full（API 建立的），或每個 item 都是 full（Paddle 後台的全額退款最上層是 partial，sandbox 實測）
 * - 要取消的是 D1 裡還沒 canceled 的訂閱（同一個 Paddle 帳號底下其他產品的退款不動），而且這筆扣款還沒記成已退款：
 *   同一筆退款的 created 與 updated 都是 approved 時只取消一次
 */
export async function refundOutcome(db: D1Database, event: unknown): Promise<RefundOutcome | undefined> {
  const e = object(event);
  const eventId = text(e.event_id);
  const eventType = text(e.event_type);
  const data = object(e.data);
  const adjustmentId = text(data.id);
  const transactionId = text(data.transaction_id);
  const subscriptionId = text(data.subscription_id);
  const status = text(data.status);
  if (!eventId || !adjustmentId || !transactionId || !subscriptionId) return undefined;
  if (eventType !== 'adjustment.created' && eventType !== 'adjustment.updated') return undefined;
  if (text(data.action) !== 'refund' || (status !== 'approved' && status !== 'rejected')) return undefined;
  const items = Array.isArray(data.items) ? data.items.map((item) => text(object(item).type)) : [];
  if (text(data.type) !== 'full' && (items.length === 0 || items.some((type) => type !== 'full'))) return undefined;
  if (await eventHandled(db, eventId)) return undefined;
  const [subscription, charge] = await Promise.all([
    db.prepare('SELECT status FROM subscriptions WHERE paddle_subscription_id = ?').bind(subscriptionId).first<{ status: string }>(),
    db.prepare('SELECT refund_status FROM charges WHERE transaction_id = ?').bind(transactionId).first<Pick<Row, 'refund_status'>>(),
  ]);
  const cancel = status === 'approved' && subscription !== null && subscription.status !== 'canceled' && charge?.refund_status !== 'approved';
  return { eventId, adjustmentId, transactionId, subscriptionId, status, cancel };
}

/**
 * 記下退款結果與處理過的事件（重送時就不再處理）。核准一律記成已退款（錢已經退了，即使先前被拒過、或是後台建立的另一筆退款）；
 * 被拒只改還沒有結果、而且是同一筆退款（或還沒記 adjustment id，後台建立的）的扣款。沒記過的扣款（#260 之前的）只記事件。
 */
export async function recordRefundOutcome(db: D1Database, outcome: RefundOutcome, now: number): Promise<void> {
  const update =
    outcome.status === 'approved'
      ? db.prepare("UPDATE charges SET refund_status = 'approved', refund_adjustment_id = ? WHERE transaction_id = ?").bind(outcome.adjustmentId, outcome.transactionId)
      : db
          .prepare(
            `UPDATE charges SET refund_status = 'rejected', refund_adjustment_id = ?
             WHERE transaction_id = ? AND (refund_status IS NULL OR refund_status = 'pending') AND (refund_adjustment_id IS NULL OR refund_adjustment_id = ?)`,
          )
          .bind(outcome.adjustmentId, outcome.transactionId, outcome.adjustmentId);
  const remember = outcome.status === 'approved' ? await rememberRefundedEmail(db, outcome, now) : [];
  await db.batch([update, ...remember, markEventHandled(db, outcome.eventId, now)]);
}

/**
 * 核准的退款記下 email（ADR 0012）：這筆扣款的 Account 的 email hash，已經記過就不動。從哪裡申請的都算（外掛、paddle.net、後台）。
 * 用扣款對 Account；扣款沒記下（#260 之前的、或扣款事件還沒到）就用訂閱對。帳號已經刪了就對不到、不記
 * （處理中就刪帳號的，刪除時已經記下，見 auth.ts 的 deleteAccount）。
 */
async function rememberRefundedEmail(db: D1Database, { transactionId, subscriptionId }: RefundOutcome, now: number): Promise<D1PreparedStatement[]> {
  const row = await db
    .prepare(
      `SELECT email FROM accounts WHERE id = COALESCE(
         (SELECT account_id FROM charges WHERE transaction_id = ?1),
         (SELECT account_id FROM subscriptions WHERE paddle_subscription_id = ?2))`,
    )
    .bind(transactionId, subscriptionId)
    .first<{ email: string }>();
  if (!row) return [];
  return [db.prepare('INSERT INTO refunded_emails (email_hash, refunded_at) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(await sha256(row.email), now)];
}
