/**
 * Worker 測試共用的假 Paddle：Paddle API 用 vi.spyOn(fetch) 假的，webhook 用測試的 secret 簽好再送給真正的 Worker。
 * secret 與 API 網址在 vitest.config.ts 的 bindings。
 */
import { exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { CHECKOUT_PATH, PADDLE_WEBHOOK_PATH } from '../../../src/shared/hosted-api.ts';
import { post } from './http.ts';

export const PADDLE_TEST_SECRET = 'pdl_ntfset_worker_test';

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Paddle-Signature 標頭：`ts=<秒>;h1=<HMAC-SHA256(secret, "ts:body")>`。 */
export async function paddleSignature(body: string, { secret = PADDLE_TEST_SECRET, ts = Math.floor(Date.now() / 1000) } = {}): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `ts=${ts};h1=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`)))}`;
}

/** 送一個 webhook 事件；signature 沒給就用正確的簽章。 */
export async function webhook(event: unknown, { signature }: { signature?: string } = {}): Promise<Response> {
  const body = JSON.stringify(event);
  return exports.default.fetch(
    new Request(`https://api.test${PADDLE_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paddle-signature': signature ?? (await paddleSignature(body)) },
      body,
    }),
  );
}

let events = 0;

export interface SubscriptionFields {
  accountId: string;
  status?: string;
  /** 訂閱開始時間（ISO）；同時是每月重置的錨點。 */
  startedAt?: string;
  /** 這一年（目前扣款週期）的結束時間（ISO）。 */
  endsAt?: string;
  /** 排定取消：扣款週期結束時取消。 */
  cancelScheduled?: boolean;
  occurredAt?: string;
  eventId?: string;
  eventType?: string;
  subscriptionId?: string;
  /** 訂閱的 item 的 Paddle price（預設是測試的年繳 price，vitest.config.ts）。 */
  priceId?: string;
}

/** Paddle 的 subscription.* 事件（只放 Worker 會讀的欄位）。custom_data 的 account_id 是 transaction 帶過來的。 */
export function subscriptionEvent({
  accountId,
  status = 'active',
  startedAt = '2026-10-15T03:00:00.000000Z',
  endsAt = '2027-10-15T03:00:00.000000Z',
  cancelScheduled = false,
  occurredAt = new Date().toISOString(),
  eventId = `evt_test_${++events}_${crypto.randomUUID().slice(0, 8)}`,
  eventType = 'subscription.updated',
  subscriptionId = `sub_test_${accountId}`,
  priceId = 'pri_worker_test_yearly',
}: SubscriptionFields) {
  return {
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    notification_id: `ntf_test_${events}`,
    data: {
      id: subscriptionId,
      status,
      customer_id: `ctm_test_${accountId}`,
      started_at: startedAt,
      first_billed_at: startedAt,
      current_billing_period: { starts_at: startedAt, ends_at: endsAt },
      scheduled_change: cancelScheduled ? { action: 'cancel', effective_at: endsAt, resume_at: null } : null,
      items: [{ status: 'active', quantity: 1, price: { id: priceId } }],
      custom_data: { account_id: accountId },
    },
  };
}

export interface AdjustmentFields {
  subscriptionId: string;
  status?: string;
  action?: string;
  /** 每個 item 的 type。Paddle 後台的「全額退款」送來的最上層 type 是 partial、item 才是 full（sandbox 實測）。 */
  itemTypes?: string[];
  type?: string;
  eventType?: string;
  eventId?: string;
  /** adjustment id（Worker 建立退款時記下的 id，核准、被拒的事件對得到它）。 */
  adjustmentId?: string;
  /** 退款的是哪一筆扣款。 */
  transactionId?: string;
}

/**
 * Paddle 的 adjustment.* 事件（只放 Worker 會讀的欄位）。預設是後台按「全額退款」、Paddle 核准之後送來的樣子。
 * 用 API 建立的全額退款（退款 API）最上層 type 是 full、item 也是 full：建立時送 adjustment.created（pending_approval），
 * 核准後送 adjustment.updated（approved），sandbox 約 8 分鐘（#261 sandbox 實測，2026-11-11）。
 */
export function adjustmentEvent({
  subscriptionId,
  status = 'approved',
  action = 'refund',
  itemTypes = ['full'],
  type = 'partial',
  eventType = 'adjustment.updated',
  eventId = `evt_test_${++events}_${crypto.randomUUID().slice(0, 8)}`,
  adjustmentId = `adj_test_${events}`,
  transactionId = `txn_test_${events}`,
}: AdjustmentFields) {
  return {
    event_id: eventId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    notification_id: `ntf_test_${events}`,
    data: {
      id: adjustmentId,
      action,
      type,
      status,
      transaction_id: transactionId,
      subscription_id: subscriptionId,
      items: itemTypes.map((itemType, i) => ({ type: itemType, item_id: `txnitm_test_${i}`, amount: '2000' })),
    },
  };
}

export interface TransactionFields {
  /** 有 custom_data 的話（首購：Worker 建立 transaction 時放的）。續約的 transaction 用 subscriptionId 對到 Account。 */
  accountId?: string;
  subscriptionId: string;
  transactionId?: string;
  /** 扣款時間（ISO）。 */
  billedAt?: string;
  /** 實付金額（美分，Paddle 的 details.totals.grand_total 是字串）。 */
  grandTotal?: string;
  eventId?: string;
}

/** Paddle 的 transaction.completed 事件（只放 Worker 會讀的欄位）：一次成功的扣款。 */
export function transactionEvent({
  accountId,
  subscriptionId,
  transactionId = `txn_test_${crypto.randomUUID().slice(0, 8)}`,
  billedAt = new Date().toISOString(),
  grandTotal = '4800',
  eventId = `evt_test_${++events}_${crypto.randomUUID().slice(0, 8)}`,
}: TransactionFields) {
  return {
    event_id: eventId,
    event_type: 'transaction.completed',
    occurred_at: billedAt,
    notification_id: `ntf_test_${events}`,
    data: {
      id: transactionId,
      status: 'completed',
      subscription_id: subscriptionId,
      customer_id: 'ctm_test',
      billed_at: billedAt,
      currency_code: 'USD',
      details: { totals: { subtotal: grandTotal, tax: '0', total: grandTotal, grand_total: grandTotal } },
      custom_data: accountId ? { account_id: accountId } : null,
    },
  };
}

/** Paddle API 的假回應：依序回傳，記下送出的網址與 body。 */
export function fakePaddle(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body as string) : undefined });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  });
  return { calls };
}

export const transactionCreated = (id = `txn_test_${crypto.randomUUID().slice(0, 8)}`) => () =>
  Response.json({ data: { id, status: 'ready', checkout: { url: 'https://approved.example/pay?_ptxn=' + id } } }, { status: 201 });

/**
 * 走一次建立 checkout，回傳 Worker 放進 transaction custom_data 的 Account id（webhook 事件要帶它）。
 * 之後要再呼叫 fetch 的測試自己 vi.restoreAllMocks()。
 */
export async function checkoutAccountId(token: string): Promise<string> {
  const paddle = fakePaddle([transactionCreated()]);
  const response = await post(CHECKOUT_PATH, { locale: 'zh-tw', billingPeriod: 'yearly' }, { token });
  if (response.status !== 200) throw new Error(`checkout 失敗：${response.status} ${await response.text()}`);
  vi.restoreAllMocks();
  return (paddle.calls[0]!.body as { custom_data: { account_id: string } }).custom_data.account_id;
}
