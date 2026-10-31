/**
 * Subscription（spec #86「額度規則」「Worker API」、#94）：建立 checkout、Paddle webhook、管理訂閱。
 * 從 HTTP 觀察：webhook 套用之後，GET /v1/account 的方案與剩餘頁數。Paddle API 用 vi.spyOn(fetch) 假的，webhook 用測試的 secret 簽。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_PATH,
  CHECKOUT_PATH,
  DEV_FREE_PAGES_PATH,
  PORTAL_PATH,
  TRANSLATE_PATH,
  type AccountResponse,
  type Quota,
} from '../../src/shared/hosted-api.ts';
import type { TranslateInput } from '../../src/shared/translator.ts';
import { fakeAnthropic, reply } from './test/anthropic.ts';
import { freshEmail, get, post, signIn } from './test/http.ts';
import { checkoutAccountId, fakePaddle, paddleSignature, subscriptionEvent, transactionCreated, webhook, type SubscriptionFields } from './test/paddle.ts';

const quota = async (token: string): Promise<Quota> => ((await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse).quota;

/** 把時間固定在 iso（session、webhook 簽章的 ts、本月週期都看這個時間）。 */
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

/** 登入並走一次 checkout，回傳 email、token 與 Worker 放進 transaction 的 Account id。 */
async function subscriber(): Promise<{ email: string; token: string; accountId: string }> {
  const email = freshEmail();
  const token = await signIn(email);
  return { email, token, accountId: await checkoutAccountId(token) };
}

const input: TranslateInput = { seriesNotes: [], priorPages: [], items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }] };
const ok = reply({ items: [{ id: 'b1', reading: 'おはよう', zh: '早安', unreadable: false, sfx: false }] });

/** 依序翻譯 n 頁（Anthropic 都成功），回傳每次的 status。 */
async function translate(token: string, n = 1): Promise<number[]> {
  fakeAnthropic(Array.from({ length: n }, () => ok));
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await post(TRANSLATE_PATH, input, { token })).status);
  vi.restoreAllMocks();
  return statuses;
}

/** 送一個簽好的 subscription 事件，確認 Worker 回 200。 */
async function send(fields: SubscriptionFields): Promise<void> {
  const response = await webhook(subscriptionEvent(fields));
  expect(response.status).toBe(200);
}

/** 訂閱中的額度；Monthly Page Limit 在測試是 3（vitest.config.ts）。 */
const subscribed = (fields: Partial<Extract<Quota, { plan: 'subscribed' }>> = {}): Quota => ({
  plan: 'subscribed',
  remaining: 3,
  limit: 3,
  resetsAt: Date.parse('2026-11-15T03:00:00Z'),
  status: 'active',
  cancelScheduled: false,
  periodEndsAt: Date.parse('2027-10-15T03:00:00Z'),
  ...fields,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('建立 checkout', () => {
  it('用 Paddle API 建立年繳 price 的 transaction，回傳產品網站 checkout 頁的網址（不用 Paddle 的 checkout.url）', async () => {
    const token = await signIn();
    const paddle = fakePaddle([transactionCreated('txn_01abc')]);

    const response = await post(CHECKOUT_PATH, { locale: 'en' }, { token });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'http://localhost:4321/en/checkout?_ptxn=txn_01abc' });
    expect(paddle.calls).toHaveLength(1);
    const [call] = paddle.calls;
    expect(call!.url).toBe('https://paddle.test/transactions');
    expect(new Headers(call!.init.headers).get('authorization')).toBe('Bearer pdl_sdbx_apikey_worker_test');
    expect(call!.body).toMatchObject({ items: [{ price_id: 'pri_worker_test', quantity: 1 }], custom_data: { account_id: expect.any(String) } });
  });

  it('不認得的語言用 zh-tw', async () => {
    const token = await signIn();
    fakePaddle([transactionCreated('txn_01def')]);

    const response = await post(CHECKOUT_PATH, { locale: 'fr' }, { token });

    expect(await response.json()).toEqual({ url: 'http://localhost:4321/zh-tw/checkout?_ptxn=txn_01def' });
  });

  it('Account id 只來自 session：client 在 body 帶別的 account_id、custom_data 都不採用', async () => {
    const token = await signIn();
    const accountId = await checkoutAccountId(token);
    const paddle = fakePaddle([transactionCreated()]);

    await post(CHECKOUT_PATH, { locale: 'zh-tw', account_id: 'someone-else', custom_data: { account_id: 'someone-else' } }, { token });

    expect(paddle.calls[0]!.body).toMatchObject({ custom_data: { account_id: accountId } });
    expect(accountId).not.toBe('someone-else');
  });

  it('沒登入回 401，不呼叫 Paddle', async () => {
    const paddle = vi.spyOn(globalThis, 'fetch');

    const response = await post(CHECKOUT_PATH, { locale: 'zh-tw' });

    expect(response.status).toBe(401);
    expect(paddle).not.toHaveBeenCalled();
  });

  it('Paddle API 失敗回 502', async () => {
    const token = await signIn();
    fakePaddle([() => Response.json({ error: { code: 'forbidden' } }, { status: 403 })]);

    expect((await post(CHECKOUT_PATH, { locale: 'zh-tw' }, { token })).status).toBe(502);
  });
});

describe('Paddle webhook', () => {
  it('subscription.created（active）之後是訂閱中：本月額度全滿、從開始日起下個月同一天重置', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();

    await send({ accountId, eventType: 'subscription.created', startedAt: '2026-10-15T03:00:00Z' });

    expect(await quota(token)).toEqual(subscribed());
  });

  it('簽章錯誤回 401，不套用', async () => {
    const { token, accountId } = await subscriber();
    const event = subscriptionEvent({ accountId });

    const response = await webhook(event, { signature: await paddleSignature(JSON.stringify(event), { secret: 'pdl_ntfset_wrong' }) });

    expect(response.status).toBe(401);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
  });

  it('沒有簽章、或 body 被改過回 401', async () => {
    const { token, accountId } = await subscriber();
    const event = subscriptionEvent({ accountId });
    const signedForOther = await paddleSignature(JSON.stringify({ ...event, event_id: 'evt_other' }));

    expect((await webhook(event, { signature: '' })).status).toBe(401);
    expect((await webhook(event, { signature: signedForOther })).status).toBe(401);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
  });

  it('簽章的時間差超過 5 分鐘回 401（擋重送舊的請求）', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    const event = subscriptionEvent({ accountId });
    const ts = Math.floor(Date.parse('2026-10-30T11:54:00Z') / 1000);

    const response = await webhook(event, { signature: await paddleSignature(JSON.stringify(event), { ts }) });

    expect(response.status).toBe(401);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
  });
});

describe('Paddle webhook：重複與亂序', () => {
  it('同一個 event_id 重送只套用一次（回 200，不再改狀態）', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, eventId: 'evt_dup_1', occurredAt: '2026-10-30T11:00:00Z' });

    await send({ accountId, eventId: 'evt_dup_1', occurredAt: '2026-10-30T11:30:00Z', status: 'canceled' });

    expect(await quota(token)).toEqual(subscribed());
  });

  it('比已經套用的事件舊的事件不會覆蓋新狀態', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, occurredAt: '2026-10-30T11:30:00Z', cancelScheduled: true });

    await send({ accountId, eventType: 'subscription.created', occurredAt: '2026-10-30T11:00:00Z' });

    expect(await quota(token)).toEqual(subscribed({ cancelScheduled: true }));
  });

  it('其他事件（transaction.completed）與不存在的 Account 都回 200、不改狀態', async () => {
    const { token } = await subscriber();

    const other = { event_id: 'evt_txn_1', event_type: 'transaction.completed', occurred_at: new Date().toISOString(), data: {} };
    expect((await webhook(other)).status).toBe(200);
    expect((await webhook(subscriptionEvent({ accountId: 'no-such-account' }))).status).toBe(200);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
  });
});

describe('Paddle webhook：重新訂閱（舊訂閱與新訂閱的事件交錯）', () => {
  it('paused 之後重新訂閱：新訂閱生效；之後才送來的舊訂閱事件（取消）不會把新訂閱蓋掉', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, subscriptionId: 'sub_old', eventType: 'subscription.paused', status: 'paused', occurredAt: '2026-10-30T10:00:00Z' });
    await send({ accountId, subscriptionId: 'sub_new', eventType: 'subscription.created', occurredAt: '2026-10-30T11:00:00Z' });

    await send({ accountId, subscriptionId: 'sub_old', eventType: 'subscription.canceled', status: 'canceled', occurredAt: '2026-10-30T11:30:00Z' });

    expect(await quota(token)).toEqual(subscribed());
  });

  it('新訂閱的事件比舊訂閱最後一個事件還早發生（送達順序顛倒）也照樣生效', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, subscriptionId: 'sub_old', eventType: 'subscription.paused', status: 'paused', occurredAt: '2026-10-30T10:00:00Z' });
    await send({ accountId, subscriptionId: 'sub_old', eventType: 'subscription.canceled', status: 'canceled', occurredAt: '2026-10-30T11:30:00Z' });

    await send({ accountId, subscriptionId: 'sub_new', eventType: 'subscription.created', occurredAt: '2026-10-30T11:00:00Z' });

    expect(await quota(token)).toEqual(subscribed());
  });

  it('目前的訂閱有權限時，其他訂閱的事件一律不套用（即使也是 active）', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, subscriptionId: 'sub_new', eventType: 'subscription.created', occurredAt: '2026-10-30T10:00:00Z' });

    await send({ accountId, subscriptionId: 'sub_other', cancelScheduled: true, occurredAt: '2026-10-30T11:00:00Z' });

    expect(await quota(token)).toEqual(subscribed());
  });
});

describe('訂閱狀態與權限', () => {
  it('排定取消：這一年結束前照常訂閱中（不會續訂）；subscription.canceled 之後才回到只剩 Free Pages', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, occurredAt: '2026-10-30T10:00:00Z' });

    await send({ accountId, occurredAt: '2026-10-30T11:00:00Z', cancelScheduled: true });
    expect(await quota(token)).toEqual(subscribed({ cancelScheduled: true }));
    expect(await translate(token)).toEqual([200]);

    // 這一年結束時 Paddle 送 subscription.canceled（session 閒置 180 天會失效，所以時間不真的往後跳一年）
    await send({ accountId, eventType: 'subscription.canceled', status: 'canceled', occurredAt: '2026-10-30T11:30:00Z' });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
  });

  it('past_due（扣款失敗重試中）仍然有權限、可以翻譯', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();

    await send({ accountId, eventType: 'subscription.past_due', status: 'past_due' });

    expect(await quota(token)).toEqual(subscribed({ status: 'pastDue' }));
    expect(await translate(token)).toEqual([200]);
  });

  it('paused 沒有權限，只剩 Free Pages', async () => {
    const { token, accountId } = await subscriber();

    await send({ accountId, eventType: 'subscription.paused', status: 'paused' });

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
  });
});

describe('Monthly Page Limit', () => {
  it('訂閱中只扣本月額度，Free Pages 不動；訂閱結束後剩下的 Free Pages 照常可用', async () => {
    at('2026-10-30T12:00:00Z');
    const { email, token, accountId } = await subscriber();
    expect((await post(DEV_FREE_PAGES_PATH, { email, remaining: 10 })).status).toBe(204);
    await send({ accountId, occurredAt: '2026-10-30T10:00:00Z' });

    expect(await translate(token, 2)).toEqual([200, 200]);
    expect(await quota(token)).toEqual(subscribed({ remaining: 1 }));

    await send({ accountId, eventType: 'subscription.canceled', status: 'canceled', occurredAt: '2026-10-30T11:00:00Z' });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 10 });
    expect(await translate(token)).toEqual([200]);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 9 });
  });

  it('本月額度用完就拒絕：402 monthlyLimitReached，不呼叫 Anthropic', async () => {
    at('2026-10-30T12:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId });
    expect(await translate(token, 3)).toEqual([200, 200, 200]);
    const anthropic = vi.spyOn(globalThis, 'fetch');

    const response = await post(TRANSLATE_PATH, input, { token });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'monthlyLimitReached' });
    expect(anthropic).not.toHaveBeenCalled();
    expect(await quota(token)).toEqual(subscribed({ remaining: 0 }));
  });

  it('從開始日起每個月同一天同一時刻重置', async () => {
    at('2026-11-15T02:59:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, startedAt: '2026-10-15T03:00:00Z', occurredAt: '2026-10-15T03:00:00Z' });
    expect(await translate(token, 3)).toEqual([200, 200, 200]);
    expect(await quota(token)).toEqual(subscribed({ remaining: 0 }));

    at('2026-11-15T03:00:00Z');
    const december = Date.parse('2026-12-15T03:00:00Z');
    expect(await quota(token)).toEqual(subscribed({ remaining: 3, resetsAt: december }));
    expect(await translate(token)).toEqual([200]);
    expect(await quota(token)).toEqual(subscribed({ remaining: 2, resetsAt: december }));
  });

  it('31 號開始的訂閱：沒有 31 號的月份在月底重置，下個月回到 31 號', async () => {
    const startedAt = '2027-01-31T08:00:00Z';
    const periodEndsAt = Date.parse('2028-01-31T08:00:00Z');
    at('2027-02-10T00:00:00Z');
    const { token, accountId } = await subscriber();
    await send({ accountId, startedAt, endsAt: '2028-01-31T08:00:00Z', occurredAt: startedAt });
    expect(await translate(token, 3)).toEqual([200, 200, 200]);
    expect(await quota(token)).toEqual(subscribed({ remaining: 0, resetsAt: Date.parse('2027-02-28T08:00:00Z'), periodEndsAt }));

    at('2027-02-28T08:00:00Z');
    expect(await quota(token)).toEqual(subscribed({ remaining: 3, resetsAt: Date.parse('2027-03-31T08:00:00Z'), periodEndsAt }));

    at('2027-04-30T09:00:00Z');
    expect(await quota(token)).toEqual(subscribed({ remaining: 3, resetsAt: Date.parse('2027-05-31T08:00:00Z'), periodEndsAt }));
  });
});

describe('checkout 與管理訂閱', () => {
  it('已經訂閱中不再建立 checkout：409 alreadySubscribed；訂閱結束後可以再訂', async () => {
    const { token, accountId } = await subscriber();
    await send({ accountId, occurredAt: '2026-10-30T10:00:00Z' });
    const paddle = vi.spyOn(globalThis, 'fetch');

    const response = await post(CHECKOUT_PATH, { locale: 'zh-tw' }, { token });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'alreadySubscribed' });
    expect(paddle).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    await send({ accountId, eventType: 'subscription.canceled', status: 'canceled', occurredAt: '2026-10-30T11:00:00Z' });
    expect(await checkoutAccountId(token)).toBe(accountId);
  });

  it('管理訂閱：替這個 Account 的 customer 建立 customer portal session，回傳網址', async () => {
    const { token, accountId } = await subscriber();
    await send({ accountId, subscriptionId: 'sub_01portal' });
    const portal = { id: 'cpls_01', urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_01' } } };
    const paddle = fakePaddle([() => Response.json({ data: portal }, { status: 201 })]);

    const response = await post(PORTAL_PATH, {}, { token });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://customer-portal.paddle.com/cpl_01' });
    expect(paddle.calls[0]!.url).toBe(`https://paddle.test/customers/ctm_test_${accountId}/portal-sessions`);
    expect(paddle.calls[0]!.body).toEqual({ subscription_ids: ['sub_01portal'] });
  });

  it('沒訂閱過的 Account 管理訂閱回 404，不呼叫 Paddle', async () => {
    const token = await signIn();
    const paddle = vi.spyOn(globalThis, 'fetch');

    expect((await post(PORTAL_PATH, {}, { token })).status).toBe(404);
    expect(paddle).not.toHaveBeenCalled();
  });
});
