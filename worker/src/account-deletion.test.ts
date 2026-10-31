/**
 * 刪除帳號（spec #86「Worker API」、#95）：DELETE /v1/account 取消 Paddle 訂閱、刪除 Account 的所有資料、撤銷所有 token，
 * 只保留 Free Pages 領取紀錄（email hash）。從 HTTP 觀察；刪除後 D1 裡還剩什麼沒有 API 看得到，那幾條直接查 D1
 * （跟「秘密只存 hash」一樣，是 docs/agents/testing.md 的例外）。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH, SEND_CODE_PATH, SIGN_OUT_PATH, TRANSLATE_PATH, VERIFY_CODE_PATH } from '../../src/shared/hosted-api.ts';
import type { TranslateInput } from '../../src/shared/translator.ts';
import { sha256 } from './hash.ts';
import { fakeAnthropic, reply } from './test/anthropic.ts';
import { del, freshEmail, get, post, signIn } from './test/http.ts';
import { checkoutAccountId, fakePaddle, subscriptionEvent, webhook } from './test/paddle.ts';

const input: TranslateInput = { seriesNotes: [], priorPages: [], items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }] };
const ok = reply({ items: [{ id: 'b1', reading: 'おはよう', zh: '早安', unreadable: false, sfx: false }] });

/** Paddle 的取消訂閱回應：排定在扣款週期結束時取消。 */
const canceled = () => Response.json({ data: { id: 'sub_test', status: 'active', scheduled_change: { action: 'cancel' } } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('刪除帳號', () => {
  it('刪除後這個 Account 的所有 token 都失效（401 signedOut）', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const other = await signIn(email);

    expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

    for (const t of [token, other]) {
      const response = await get(ACCOUNT_PATH, t);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'signedOut' });
    }
  });

  it('同一個 email 刪除後重新註冊：是新的 Account，但拿不到 Free Pages', async () => {
    const email = freshEmail();
    await del(ACCOUNT_PATH, await signIn(email));

    const response = await get(ACCOUNT_PATH, await signIn(email));

    expect(await response.json()).toEqual({ email, quota: { plan: 'free', remaining: 0 } });
  });

  it('有訂閱的帳號：先對 Paddle 送出取消（扣款週期結束時才失效、不退款），再刪除', async () => {
    const token = await signIn();
    const accountId = await checkoutAccountId(token);
    await webhook(subscriptionEvent({ accountId }));
    const paddle = fakePaddle([canceled]);

    expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

    expect(paddle.calls).toEqual([
      expect.objectContaining({ url: `https://paddle.test/subscriptions/sub_test_${accountId}/cancel`, body: { effective_from: 'next_billing_period' } }),
    ]);
    expect((await get(ACCOUNT_PATH, token)).status).toBe(401);
  });

  // Paddle 的規則：paused 只能立即取消；past_due 排到期末取消的話，到期前 Paddle 會繼續嘗試扣款，所以刪除帳號時也立即取消
  for (const [status, cancelScheduled] of [
    ['paused', false],
    ['past_due', false],
    ['past_due', true],
  ] as const) {
    it(`${status}${cancelScheduled ? '（已排定取消）' : ''}的訂閱：立即取消，不再嘗試扣款`, async () => {
      const token = await signIn();
      const accountId = await checkoutAccountId(token);
      await webhook(subscriptionEvent({ accountId, status, cancelScheduled }));
      const paddle = fakePaddle([canceled]);

      expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

      expect(paddle.calls).toEqual([
        expect.objectContaining({ url: `https://paddle.test/subscriptions/sub_test_${accountId}/cancel`, body: { effective_from: 'immediately' } }),
      ]);
    });
  }

  it('已經取消的訂閱不呼叫 Paddle', async () => {
    const token = await signIn();
    await webhook(subscriptionEvent({ accountId: await checkoutAccountId(token), status: 'canceled', eventType: 'subscription.canceled' }));
    const paddle = fakePaddle([]);

    expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

    expect(paddle.calls).toEqual([]);
  });

  it('Paddle 取消失敗回 502、什麼都不刪（避免帳號刪了訂閱還在扣款），讀者可以再試一次', async () => {
    const token = await signIn();
    const accountId = await checkoutAccountId(token);
    await webhook(subscriptionEvent({ accountId }));
    fakePaddle([() => Response.json({ error: { code: 'internal_error' } }, { status: 500 })]);

    expect((await del(ACCOUNT_PATH, token)).status).toBe(502);

    expect((await get(ACCOUNT_PATH, token)).status).toBe(200);
  });

  it('沒訂閱、或訂閱已經排定取消的帳號不呼叫 Paddle', async () => {
    const free = await signIn();
    const canceling = await signIn();
    await webhook(subscriptionEvent({ accountId: await checkoutAccountId(canceling), cancelScheduled: true }));
    const paddle = fakePaddle([]);

    expect((await del(ACCOUNT_PATH, free)).status).toBe(204);
    expect((await del(ACCOUNT_PATH, canceling)).status).toBe(204);

    expect(paddle.calls).toEqual([]);
  });

  it('刪除後 Paddle 送來的訂閱事件（排定取消、取消）回 200，不會重建資料', async () => {
    const token = await signIn();
    const accountId = await checkoutAccountId(token);
    await webhook(subscriptionEvent({ accountId }));
    fakePaddle([canceled]);
    await del(ACCOUNT_PATH, token);

    expect((await webhook(subscriptionEvent({ accountId, cancelScheduled: true }))).status).toBe(200);
    expect((await webhook(subscriptionEvent({ accountId, status: 'canceled', eventType: 'subscription.canceled' }))).status).toBe(200);

    const { results } = await env.DB.prepare('SELECT * FROM subscriptions WHERE account_id = ?').bind(accountId).all();
    expect(results).toEqual([]);
  });

  it('D1 裡只剩這個 email 的 hash（Free Pages 領取紀錄），查不到 email、session、額度、用量紀錄、訂閱', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const accountId = await checkoutAccountId(token);
    expect((await webhook(subscriptionEvent({ accountId }))).status).toBe(200);
    fakeAnthropic([ok]);
    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(200);
    fakePaddle([canceled]);

    expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

    for (const [table, column] of [
      ['accounts', 'id'],
      ['sessions', 'account_id'],
      ['quotas', 'account_id'],
      ['usage_records', 'account_id'],
      ['subscriptions', 'account_id'],
    ] as const) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).bind(accountId).all();
      expect(results, table).toEqual([]);
    }
    const grants = await env.DB.prepare('SELECT * FROM free_page_grants WHERE email_hash = ?').bind(await sha256(email)).all();
    expect(grants.results).toHaveLength(1);
  });

  it('寄了驗證碼還沒用（例如在別台電腦寄的）：刪除時這個 email 的驗證碼也一起刪掉，D1 裡查不到 email', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    expect((await post(SEND_CODE_PATH, { email })).status).toBe(204);

    expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

    expect((await env.DB.prepare('SELECT * FROM otps WHERE email = ?').bind(email).all()).results).toEqual([]);
  });

  it('登入後有人猜錯驗證碼：刪除時這個 email 的驗證次數也一起刪掉', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    await post(SEND_CODE_PATH, { email });
    await post(VERIFY_CODE_PATH, { email, code: 'abcdef' });

    expect((await del(ACCOUNT_PATH, token)).status).toBe(204);

    expect((await env.DB.prepare('SELECT * FROM verify_attempts WHERE email_hash = ?').bind(await sha256(email)).all()).results).toEqual([]);
  });
});

describe('用不到的登入資料不留著', () => {
  it('驗證成功後，這個 email 的驗證碼那一列就刪掉', async () => {
    const email = freshEmail();

    await signIn(email);

    expect((await env.DB.prepare('SELECT * FROM otps WHERE email = ?').bind(email).all()).results).toEqual([]);
  });

  it('登出的 token 不會一直留著：任何人寄新的驗證碼時就刪掉', async () => {
    const token = await signIn(freshEmail());
    expect((await post(SIGN_OUT_PATH, {}, { token })).status).toBe(204);

    await post(SEND_CODE_PATH, { email: freshEmail() });

    expect((await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(await sha256(token)).all()).results).toEqual([]);
  });

  it('閒置超過 180 天失效的 token 也一樣刪掉；還在用的 token 不受影響', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const idle = await signIn(freshEmail());
    vi.setSystemTime(Date.now() + 100 * 24 * 60 * 60_000);
    const active = await signIn(freshEmail());

    vi.setSystemTime(Date.now() + 81 * 24 * 60 * 60_000);
    await post(SEND_CODE_PATH, { email: freshEmail() });

    expect((await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(await sha256(idle)).all()).results).toEqual([]);
    expect((await get(ACCOUNT_PATH, active)).status).toBe(200);
  });

  it('寄了但沒用的驗證碼不會一直留著：過期之後，任何人寄新的驗證碼時就刪掉', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const abandoned = freshEmail();
    await post(SEND_CODE_PATH, { email: abandoned });

    vi.setSystemTime(Date.now() + 11 * 60_000);
    await post(SEND_CODE_PATH, { email: freshEmail() });

    expect((await env.DB.prepare('SELECT * FROM otps WHERE email = ?').bind(abandoned).all()).results).toEqual([]);
  });
});
