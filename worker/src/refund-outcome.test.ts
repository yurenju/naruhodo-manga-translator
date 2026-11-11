/**
 * 退款的結果（#261）：讀者按「申請退款」後，Paddle 核准或拒絕會送 adjustment 的 webhook。核准 → 立即取消訂閱、
 * GET /v1/account 的 refund.status 變成 refunded；被拒 → 記下被拒、訂閱照常，退款 API 之後拒絕同一筆。
 * 從 HTTP 觀察：webhook 的回應、送給（假的）Paddle API 的請求，以及之後 GET /v1/account 與退款 API 看到什麼。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH, REFUND_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import { get, post, signIn } from './test/http.ts';
import { adjustmentEvent, checkoutAccountId, fakePaddle, subscriptionEvent, transactionEvent, webhook } from './test/paddle.ts';

const account = async (token: string): Promise<AccountResponse> => (await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse;

const canceled = () => Response.json({ data: { id: 'sub_test', status: 'canceled' } });

async function send(event: unknown): Promise<void> {
  expect((await webhook(event)).status).toBe(200);
}

/** 剛扣款、按了「申請退款」的訂閱者：Paddle 建立的退款是 adjustmentId。 */
async function refundRequested(adjustmentId = `adj_test_${crypto.randomUUID().slice(0, 8)}`) {
  const token = await signIn();
  const accountId = await checkoutAccountId(token);
  const subscriptionId = `sub_test_${accountId}`;
  const transactionId = `txn_test_${accountId}`;
  await send(subscriptionEvent({ accountId }));
  await send(transactionEvent({ accountId, subscriptionId, transactionId }));
  fakePaddle([() => Response.json({ data: { id: adjustmentId, status: 'pending_approval', action: 'refund', type: 'full' } }, { status: 201 })]);
  expect((await post(REFUND_PATH, {}, { token })).status).toBe(204);
  vi.restoreAllMocks();
  return { token, accountId, subscriptionId, transactionId, adjustmentId };
}

/** API 建立的全額退款的 adjustment 事件：最上層 type 與 item 都是 full（sandbox 實測，見 test/paddle.ts 的 adjustmentEvent）。 */
const apiRefund = (r: Awaited<ReturnType<typeof refundRequested>>, fields: Partial<Parameters<typeof adjustmentEvent>[0]> = {}) =>
  adjustmentEvent({ subscriptionId: r.subscriptionId, transactionId: r.transactionId, adjustmentId: r.adjustmentId, type: 'full', ...fields });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Paddle 核准退款', () => {
  for (const eventType of ['adjustment.created', 'adjustment.updated']) {
    it(`${eventType} 的核准：立即取消訂閱，退款資訊變成已退款`, async () => {
      const r = await refundRequested();
      const paddle = fakePaddle([canceled]);

      await send(apiRefund(r, { eventType }));

      expect(paddle.calls).toEqual([
        expect.objectContaining({ url: `https://paddle.test/subscriptions/${r.subscriptionId}/cancel`, body: { effective_from: 'immediately' } }),
      ]);
      vi.restoreAllMocks();
      expect((await account(r.token)).refund).toMatchObject({ status: 'refunded', eligible: false });
    });
  }
});

describe('同一筆退款不重複處理', () => {
  it('建立時就核准（adjustment.created）、之後又送 adjustment.updated：只取消一次', async () => {
    const r = await refundRequested();
    const paddle = fakePaddle([canceled]);

    await send(apiRefund(r, { eventType: 'adjustment.created' }));
    await send(apiRefund(r, { eventType: 'adjustment.updated' }));

    expect(paddle.calls).toHaveLength(1);
  });

  it('同一個事件重送：只取消一次', async () => {
    const r = await refundRequested();
    const event = apiRefund(r);
    const paddle = fakePaddle([canceled]);

    await send(event);
    await send(event);

    expect(paddle.calls).toHaveLength(1);
  });

  it('先送「等核准」再送核准：核准時才取消', async () => {
    const r = await refundRequested();
    const paddle = fakePaddle([canceled]);

    await send(apiRefund(r, { eventType: 'adjustment.created', status: 'pending_approval' }));
    expect(paddle.calls).toEqual([]);
    expect((await account(r.token)).refund).toMatchObject({ status: 'pending' });

    await send(apiRefund(r, { eventType: 'adjustment.updated' }));
    expect(paddle.calls).toHaveLength(1);
  });

  it('取消失敗：回 5xx、還沒記成已退款，Paddle 重送時再取消', async () => {
    const r = await refundRequested();
    const event = apiRefund(r);
    fakePaddle([() => Response.json({ error: { code: 'internal_error' } }, { status: 500 })]);

    expect((await webhook(event)).status).toBeGreaterThanOrEqual(500);
    vi.restoreAllMocks();
    expect((await account(r.token)).refund).toMatchObject({ status: 'pending' });

    const paddle = fakePaddle([canceled]);
    await send(event);
    expect(paddle.calls).toHaveLength(1);
  });
});

describe('Paddle 拒絕退款', () => {
  it('記下被拒、不取消訂閱；退款 API 之後拒絕同一筆', async () => {
    const r = await refundRequested();
    const paddle = fakePaddle([]);

    await send(apiRefund(r, { eventType: 'adjustment.updated', status: 'rejected' }));

    expect(paddle.calls).toEqual([]);
    const after = await account(r.token);
    expect(after.refund).toMatchObject({ status: 'rejected', eligible: false, inWindow: true });
    expect(after.quota).toMatchObject({ plan: 'subscribed', status: 'active' });
    const response = await post(REFUND_PATH, {}, { token: r.token });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'refundRejected' });
  });

  it('另一筆退款（不是讀者申請的那筆）被拒：不改讀者的處理中', async () => {
    const r = await refundRequested();
    fakePaddle([]);

    await send(apiRefund(r, { adjustmentId: 'adj_someone_else', status: 'rejected' }));

    expect((await account(r.token)).refund).toMatchObject({ status: 'pending' });
  });
});

describe('從 Paddle 後台人工建立的全額退款', () => {
  it('核准就立即取消，扣款記成已退款', async () => {
    const token = await signIn();
    const accountId = await checkoutAccountId(token);
    const subscriptionId = `sub_test_${accountId}`;
    const transactionId = `txn_test_${accountId}`;
    await send(subscriptionEvent({ accountId }));
    await send(transactionEvent({ accountId, subscriptionId, transactionId }));
    const paddle = fakePaddle([canceled]);

    // 後台的全額退款：最上層 type 是 partial、item 都是 full（fixture 的預設）
    await send(adjustmentEvent({ subscriptionId, transactionId }));

    expect(paddle.calls).toHaveLength(1);
    vi.restoreAllMocks();
    expect((await account(token)).refund).toMatchObject({ status: 'refunded' });
  });
});
