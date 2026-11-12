/**
 * 申請退款（#260，ADR 0012 的 Refund Window）：Worker 記住每次成功扣款（transaction.completed），GET /v1/account 回傳退款資訊，
 * 讀者按「申請退款」時 Worker 向 Paddle 建立全額退款、記為處理中，不取消訂閱。
 * 從 HTTP 觀察：GET /v1/account 的 refund、退款 API 的回應，以及送給（假的）Paddle API 的請求。核准後的取消在 refund.test.ts。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH, REFUND_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import { get, post, signIn } from './test/http.ts';
import { adjustmentEvent, checkoutAccountId, fakePaddle, subscriptionEvent, transactionEvent, webhook, type SubscriptionFields, type TransactionFields } from './test/paddle.ts';

const DAY = 24 * 60 * 60_000;

const account = async (token: string): Promise<AccountResponse> => (await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse;

/** 把時間固定在 iso（session、webhook 簽章的 ts、Refund Window 都看這個時間）。 */
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

async function send(event: unknown): Promise<void> {
  expect((await webhook(event)).status).toBe(200);
}

/** 登入、走一次 checkout、訂閱生效；回傳 token、Account id 與 Paddle subscription id。 */
async function subscriber(fields: Partial<SubscriptionFields> = {}): Promise<{ token: string; accountId: string; subscriptionId: string }> {
  const token = await signIn();
  const accountId = await checkoutAccountId(token);
  await send(subscriptionEvent({ accountId, ...fields }));
  return { token, accountId, subscriptionId: `sub_test_${accountId}` };
}

/** 訂閱者，而且 billedAt 這時成功扣款一次（首購，transaction 帶 custom_data）。 */
async function charged(billedAt: string, fields: Partial<TransactionFields> = {}, subscription: Partial<SubscriptionFields> = {}) {
  const s = await subscriber(subscription);
  const transactionId = `txn_test_${s.accountId}`;
  await send(transactionEvent({ accountId: s.accountId, subscriptionId: s.subscriptionId, transactionId, billedAt, ...fields }));
  return { ...s, transactionId };
}

const adjustmentCreated = (id = 'adj_test_1') => () => Response.json({ data: { id, status: 'pending_approval', action: 'refund', type: 'full' } }, { status: 201 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GET /v1/account 的退款資訊', () => {
  it('扣款後 14 天內：扣款時間、實付金額、截止、可以申請', async () => {
    at('2026-11-03T03:00:00Z');
    const { token } = await charged('2026-11-03T03:00:00Z');
    at('2026-11-10T03:00:00Z');

    expect((await account(token)).refund).toEqual({
      billedAt: Date.parse('2026-11-03T03:00:00Z'),
      amountUsd: 48,
      windowEndsAt: Date.parse('2026-11-17T03:00:00Z'),
      inWindow: true,
      status: 'none',
      eligible: true,
      byEmail: false,
    });
  });
});

describe('訂閱前剩下的 Free Pages（確認對話框：退款核准後恢復可用）', () => {
  it('訂閱中的 quota 帶 freePages：訂閱前沒用完的頁數，訂閱中不扣', async () => {
    const { token } = await subscriber();

    expect((await account(token)).quota).toMatchObject({ plan: 'subscribed', freePages: 100 });
  });
});

describe('GET /v1/account 的退款資訊：各種情況', () => {
  it('沒有成功扣款過：沒有 refund', async () => {
    const { token } = await subscriber();

    expect((await account(token)).refund).toBeUndefined();
  });

  it('續約的扣款（transaction 沒有 custom_data）：用訂閱對到 Account，退款期從續約那天算', async () => {
    const { token, accountId, subscriptionId } = await charged(new Date(Date.now() - 100 * DAY).toISOString());
    const renewedAt = Date.now() - 2 * DAY;
    await send(transactionEvent({ subscriptionId, transactionId: `txn_renewal_${accountId}`, billedAt: new Date(renewedAt).toISOString() }));

    expect((await account(token)).refund).toMatchObject({ billedAt: renewedAt, inWindow: true, eligible: true });
  });

  it('過了 14 天：不在退款期內，不能申請', async () => {
    at('2026-11-03T03:00:00Z');
    const { token } = await charged('2026-11-03T03:00:00Z');
    at('2026-11-17T03:00:00Z');

    expect((await account(token)).refund).toMatchObject({ inWindow: false, eligible: false });
  });

  it('實付 US$0（100% 折扣）：不能申請', async () => {
    const { token } = await charged(new Date().toISOString(), { grandTotal: '0' });

    expect((await account(token)).refund).toMatchObject({ amountUsd: 0, inWindow: true, eligible: false });
  });

  it('部分折扣：退款金額是實付金額', async () => {
    const { token } = await charged(new Date().toISOString(), { grandTotal: '100' });

    expect((await account(token)).refund).toMatchObject({ amountUsd: 1, eligible: true });
  });

  it('扣款失敗重試中：不能申請', async () => {
    const { token, accountId } = await charged(new Date().toISOString());
    await send(subscriptionEvent({ accountId, status: 'past_due' }));

    expect((await account(token)).refund).toMatchObject({ eligible: false });
  });

  it('已排定取消、還在退款期內：照樣可以申請', async () => {
    const { token, accountId } = await charged(new Date().toISOString());
    await send(subscriptionEvent({ accountId, cancelScheduled: true }));

    expect((await account(token)).refund).toMatchObject({ eligible: true });
  });

  it('同一個事件重送：只記一筆', async () => {
    const { token, accountId, subscriptionId } = await subscriber();
    const event = transactionEvent({ accountId, subscriptionId });
    await send(event);
    await send(event);

    expect((await account(token)).refund).toMatchObject({ eligible: true });
  });
});

describe('申請退款', () => {
  it('在退款期內：對 Paddle 送出這筆 transaction 的全額退款，記為處理中，不取消訂閱', async () => {
    const { token, transactionId } = await charged(new Date().toISOString());
    const paddle = fakePaddle([adjustmentCreated()]);

    expect((await post(REFUND_PATH, {}, { token })).status).toBe(204);

    expect(paddle.calls).toEqual([
      expect.objectContaining({
        url: 'https://paddle.test/adjustments',
        body: { action: 'refund', type: 'full', transaction_id: transactionId, reason: expect.any(String) },
      }),
    ]);
    vi.restoreAllMocks();
    const after = await account(token);
    expect(after.refund).toMatchObject({ status: 'pending', eligible: false });
    expect(after.quota).toMatchObject({ plan: 'subscribed', status: 'active' });
  });

  it('已排定取消、還在退款期內：照樣可以退款', async () => {
    const { token, accountId } = await charged(new Date().toISOString());
    await send(subscriptionEvent({ accountId, cancelScheduled: true }));
    fakePaddle([adjustmentCreated()]);

    expect((await post(REFUND_PATH, {}, { token })).status).toBe(204);
  });

  it('已經申請過（處理中）：拒絕，不再送 Paddle', async () => {
    const { token } = await charged(new Date().toISOString());
    fakePaddle([adjustmentCreated()]);
    await post(REFUND_PATH, {}, { token });
    vi.restoreAllMocks();
    const paddle = fakePaddle([]);

    const response = await post(REFUND_PATH, {}, { token });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'refundPending' });
    expect(paddle.calls).toEqual([]);
  });

  it('同時送來兩個請求：只建立一筆退款', async () => {
    const { token } = await charged(new Date().toISOString());
    const paddle = fakePaddle([adjustmentCreated(), adjustmentCreated('adj_test_2')]);

    const statuses = (await Promise.all([post(REFUND_PATH, {}, { token }), post(REFUND_PATH, {}, { token })])).map((r) => r.status).sort();

    expect(statuses).toEqual([204, 409]);
    expect(paddle.calls).toHaveLength(1);
  });

  it('Paddle 失敗：回 502、不記為處理中，再按一次就能送出', async () => {
    const { token } = await charged(new Date().toISOString());
    fakePaddle([() => Response.json({ error: { code: 'internal_error' } }, { status: 500 })]);

    expect((await post(REFUND_PATH, {}, { token })).status).toBe(502);
    vi.restoreAllMocks();
    expect((await account(token)).refund).toMatchObject({ status: 'none', eligible: true });

    const paddle = fakePaddle([adjustmentCreated()]);
    expect((await post(REFUND_PATH, {}, { token })).status).toBe(204);
    expect(paddle.calls).toHaveLength(1);
  });

  it('沒登入：401', async () => {
    expect((await post(REFUND_PATH, {})).status).toBe(401);
  });
});

describe('申請退款：拒絕的原因', () => {
  const refused = async (token: string) => {
    const paddle = fakePaddle([]);
    const response = await post(REFUND_PATH, {}, { token });
    expect(paddle.calls).toEqual([]);
    expect(response.status).toBe(409);
    return ((await response.json()) as { reason?: string }).reason;
  };

  it('沒有成功扣款', async () => {
    const { token } = await subscriber();

    expect(await refused(token)).toBe('refundNoCharge');
  });

  it('過了 14 天', async () => {
    at('2026-11-03T03:00:00Z');
    const { token } = await charged('2026-11-03T03:00:00Z');
    at('2026-11-17T03:00:01Z');

    expect(await refused(token)).toBe('refundWindowClosed');
  });

  it('實付 US$0', async () => {
    const { token } = await charged(new Date().toISOString(), { grandTotal: '0' });

    expect(await refused(token)).toBe('refundZeroAmount');
  });

  it('扣款失敗重試中', async () => {
    const { token, accountId } = await charged(new Date().toISOString());
    await send(subscriptionEvent({ accountId, status: 'past_due' }));

    expect(await refused(token)).toBe('refundPastDue');
  });

  it('Paddle 拒絕過這筆', async () => {
    const { token, subscriptionId, transactionId } = await charged(new Date().toISOString());
    await send(adjustmentEvent({ subscriptionId, transactionId, status: 'rejected' }));

    expect(await refused(token)).toBe('refundRejected');
    expect((await account(token)).refund).toMatchObject({ status: 'rejected', eligible: false });
  });
});
