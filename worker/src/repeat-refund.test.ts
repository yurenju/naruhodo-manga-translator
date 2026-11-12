/**
 * 重複退款（ADR 0012、REFUND.md）：同一個 email 只有第一次退款能在外掛裡申請。Paddle 核准過一次之後
 * （不管是外掛、paddle.net 還是後台建立的退款），再訂閱、扣款時退款資訊改成寫信申請（byEmail），退款 API 拒絕。
 * 刪除帳號、用同一個 email 重新註冊也一樣。從 HTTP 觀察：webhook、GET /v1/account 的 refund、退款 API 的回應。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH, REFUND_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import { del, freshEmail, get, post, signIn } from './test/http.ts';
import { adjustmentEvent, checkoutAccountId, fakePaddle, subscriptionEvent, transactionEvent, webhook } from './test/paddle.ts';

const account = async (token: string): Promise<AccountResponse> => (await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse;

async function send(event: unknown): Promise<void> {
  expect((await webhook(event)).status).toBe(200);
}

/** 這個 email 登入（沒有帳號就建立）、訂閱、在 billedAt（預設現在）扣款一次。 */
async function charged(email: string, billedAt = new Date().toISOString()) {
  const token = await signIn(email);
  const accountId = await checkoutAccountId(token);
  const n = crypto.randomUUID().slice(0, 8);
  const subscriptionId = `sub_test_${n}`;
  const transactionId = `txn_test_${n}`;
  await send(subscriptionEvent({ accountId, subscriptionId }));
  await send(transactionEvent({ accountId, subscriptionId, transactionId, billedAt }));
  return { token, accountId, subscriptionId, transactionId };
}

/** Paddle 核准這筆扣款的全額退款（後台或 paddle.net 建立的也是這個事件），Worker 取消訂閱。 */
async function refundApproved({ accountId, subscriptionId, transactionId }: Awaited<ReturnType<typeof charged>>) {
  fakePaddle([() => Response.json({ data: { id: subscriptionId, status: 'canceled' } })]);
  await send(adjustmentEvent({ subscriptionId, transactionId }));
  vi.restoreAllMocks();
  await send(subscriptionEvent({ accountId, subscriptionId, status: 'canceled' }));
}

const refused = async (token: string) => {
  const paddle = fakePaddle([]);
  const response = await post(REFUND_PATH, {}, { token });
  expect(paddle.calls).toEqual([]);
  expect(response.status).toBe(409);
  return ((await response.json()) as { reason?: string }).reason;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('同一個 email 第二次退款', () => {
  it('第一次退款不受影響：可以在外掛裡申請', async () => {
    const { token } = await charged(freshEmail());

    expect((await account(token)).refund).toMatchObject({ eligible: true, byEmail: false });
  });

  it('退款核准過、再訂閱扣款：改成寫信申請，退款 API 拒絕', async () => {
    const email = freshEmail();
    await refundApproved(await charged(email));
    const { token } = await charged(email);

    expect((await account(token)).refund).toMatchObject({ status: 'none', inWindow: true, eligible: false, byEmail: true });
    expect(await refused(token)).toBe('refundByEmail');
  });

  it('刪除帳號、同一個 email 重新註冊後再訂閱：一樣要寫信', async () => {
    const email = freshEmail();
    const first = await charged(email);
    await refundApproved(first);
    expect((await del(ACCOUNT_PATH, first.token)).status).toBe(204);
    const { token } = await charged(email);

    expect((await account(token)).refund).toMatchObject({ eligible: false, byEmail: true });
    expect(await refused(token)).toBe('refundByEmail');
  });

  it('申請退款後、核准前就刪除帳號：同一個 email 重新註冊後再訂閱，一樣要寫信', async () => {
    const email = freshEmail();
    const first = await charged(email);
    fakePaddle([() => Response.json({ data: { id: 'adj_test_pending', status: 'pending_approval', action: 'refund', type: 'full' } }, { status: 201 })]);
    expect((await post(REFUND_PATH, {}, { token: first.token })).status).toBe(204);
    // 刪除帳號會在期末取消訂閱（Paddle API）
    fakePaddle([() => Response.json({ data: { id: first.subscriptionId, status: 'active' } })]);
    expect((await del(ACCOUNT_PATH, first.token)).status).toBe(204);
    vi.restoreAllMocks();
    await send(adjustmentEvent({ subscriptionId: first.subscriptionId, transactionId: first.transactionId, adjustmentId: 'adj_test_pending', type: 'full' }));
    const { token } = await charged(email);

    expect((await account(token)).refund).toMatchObject({ eligible: false, byEmail: true });
  });

  it('核准的退款對不到記下的扣款（扣款事件還沒到）：用訂閱對到 Account，照樣記下', async () => {
    const email = freshEmail();
    const token1 = await signIn(email);
    const accountId = await checkoutAccountId(token1);
    const subscriptionId = `sub_test_${crypto.randomUUID().slice(0, 8)}`;
    await send(subscriptionEvent({ accountId, subscriptionId }));
    await refundApproved({ token: token1, accountId, subscriptionId, transactionId: 'txn_test_not_recorded' });
    const { token } = await charged(email);

    expect((await account(token)).refund).toMatchObject({ eligible: false, byEmail: true });
  });

  it('續約扣款的退款也算', async () => {
    const email = freshEmail();
    const first = await charged(email, new Date(Date.now() - 2 * 60_000).toISOString());
    const renewal = `txn_test_renewal_${crypto.randomUUID().slice(0, 8)}`;
    // 續約的 transaction 沒有 custom_data，用訂閱對到 Account
    await send(transactionEvent({ subscriptionId: first.subscriptionId, transactionId: renewal, billedAt: new Date(Date.now() - 60_000).toISOString() }));
    await refundApproved({ ...first, transactionId: renewal });
    const { token } = await charged(email);

    expect((await account(token)).refund).toMatchObject({ eligible: false, byEmail: true });
  });

  it('被拒絕的退款不算：再訂閱扣款照樣可以在外掛裡申請', async () => {
    const email = freshEmail();
    const first = await charged(email);
    await send(adjustmentEvent({ subscriptionId: first.subscriptionId, transactionId: first.transactionId, status: 'rejected' }));
    // 被拒之後訂閱照常；之後到期結束，才能重新訂閱
    await send(subscriptionEvent({ accountId: first.accountId, subscriptionId: first.subscriptionId, status: 'canceled' }));
    const { token } = await charged(email);

    expect((await account(token)).refund).toMatchObject({ eligible: true, byEmail: false });
  });

  it('扣款失敗重試中（past_due）就不提寫信：byEmail 只在原本能申請時才是 true', async () => {
    const email = freshEmail();
    await refundApproved(await charged(email));
    const { token, accountId, subscriptionId } = await charged(email);
    await send(subscriptionEvent({ accountId, subscriptionId, status: 'past_due' }));

    expect((await account(token)).refund).toMatchObject({ eligible: false, byEmail: false });
    expect(await refused(token)).toBe('refundPastDue');
  });
});
