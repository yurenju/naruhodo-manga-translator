import { describe, expect, it } from 'vitest';
import { renewalPriceConfig, switchRenewalPrice, type RenewalPriceConfig } from './paddle-renewal-price.ts';

const OLD = 'pri_old_yearly_20';
const NEW = 'pri_new_yearly_48';
const config: RenewalPriceConfig = {
  apiBaseUrl: 'https://sandbox-api.paddle.com',
  apiKey: 'pdl_sdbx_apikey_test',
  oldPriceId: OLD,
  newPriceId: NEW,
};

interface FakeSubscription {
  id: string;
  status: string;
  priceIds: string[];
  nextBilledAt: string | null;
  scheduledCancel?: boolean;
  /** 讓試算結果不是單純換價格，用來測腳本的安全檢查。 */
  previewChargesNow?: boolean;
  previewNextBilledAt?: string;
}

/** 假 Paddle：只實作腳本用到的端點，記下收到的每個請求。換價格照 do_not_bill 的行為：不扣款、下次扣款日不變。 */
function fakePaddle(subscriptions: FakeSubscription[], { pageSize = 50 } = {}) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const toPaddle = (s: FakeSubscription) => ({
    id: s.id,
    status: s.status,
    next_billed_at: s.nextBilledAt,
    scheduled_change: s.scheduledCancel ? { action: 'cancel' } : null,
    items: s.priceIds.map((id) => ({ quantity: 1, price: { id, unit_price: { amount: id === NEW ? '4800' : '2000' } } })),
  });
  const preview = (s: FakeSubscription, priceId: string) => ({
    ...toPaddle({ ...s, priceIds: [priceId], nextBilledAt: s.previewNextBilledAt ?? s.nextBilledAt }),
    immediate_transaction: s.previewChargesNow ? { details: { totals: { total: '2800', currency_code: 'USD' } } } : null,
    next_transaction: { details: { totals: { total: priceId === NEW ? '4800' : '2000', currency_code: 'USD' } } },
  });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname + url.search, body });
    if (new Headers(init?.headers).get('Authorization') !== `Bearer ${config.apiKey}`) return Response.json({}, { status: 403 });

    if (method === 'GET' && url.pathname === '/subscriptions') {
      const after = url.searchParams.get('after');
      const start = after ? subscriptions.findIndex((s) => s.id === after) + 1 : 0;
      const page = subscriptions.slice(start, start + pageSize);
      const hasMore = start + pageSize < subscriptions.length;
      const next = `${config.apiBaseUrl}/subscriptions?after=${page.at(-1)?.id}&per_page=${pageSize}`;
      return Response.json({ data: page.map(toPaddle), meta: { pagination: { next, has_more: hasMore } } });
    }
    const match = /^\/subscriptions\/([^/]+)(\/preview)?$/.exec(url.pathname);
    const subscription = subscriptions.find((s) => s.id === match?.[1]);
    if (method === 'PATCH' && subscription) {
      const priceId = body.items[0].price_id;
      if (match?.[2]) return Response.json({ data: preview(subscription, priceId) });
      subscription.priceIds = [priceId];
      return Response.json({ data: toPaddle(subscription) });
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  };
  return { fetch, requests, changes: () => requests.filter((r) => r.method === 'PATCH' && !r.path.endsWith('/preview')) };
}

describe('renewalPriceConfig', () => {
  const sandboxFile = {
    PADDLE_API_BASE_URL: 'https://sandbox-api.paddle.com',
    PADDLE_API_KEY: 'pdl_sdbx_apikey_x',
    PADDLE_PRICE_ID: OLD,
    PADDLE_PRICE_ID_YEARLY: NEW,
  };

  it('sandbox reads the wizard’s env file', () => {
    expect(renewalPriceConfig({ production: false, file: sandboxFile, env: {} })).toEqual({
      apiBaseUrl: 'https://sandbox-api.paddle.com',
      apiKey: 'pdl_sdbx_apikey_x',
      oldPriceId: OLD,
      newPriceId: NEW,
    });
  });

  it('production takes everything from the environment and talks to the live API', () => {
    const env = { PADDLE_API_KEY: 'pdl_live_apikey_x', PADDLE_PRICE_ID: OLD, PADDLE_PRICE_ID_YEARLY: NEW };
    expect(renewalPriceConfig({ production: true, file: undefined, env })).toEqual({
      apiBaseUrl: 'https://api.paddle.com',
      apiKey: 'pdl_live_apikey_x',
      oldPriceId: OLD,
      newPriceId: NEW,
    });
  });

  it('refuses a key from the other environment, or a missing value', () => {
    expect(() =>
      renewalPriceConfig({ production: true, file: undefined, env: { ...sandboxFile, PADDLE_API_KEY: 'pdl_sdbx_apikey_x' } }),
    ).toThrow(/pdl_live_apikey_/);
    expect(() =>
      renewalPriceConfig({ production: false, file: { ...sandboxFile, PADDLE_API_KEY: 'pdl_live_apikey_x' }, env: {} }),
    ).toThrow(/pdl_sdbx_apikey_/);
    expect(() =>
      renewalPriceConfig({ production: true, file: undefined, env: { PADDLE_API_KEY: 'pdl_live_apikey_x', PADDLE_PRICE_ID: OLD } }),
    ).toThrow(/PADDLE_PRICE_ID_YEARLY/);
  });
});

describe('switchRenewalPrice', () => {
  it('dry run lists only the subscriptions still on the old price and changes nothing', async () => {
    const paddle = fakePaddle([
      { id: 'sub_old', status: 'active', priceIds: [OLD], nextBilledAt: '2027-10-30T09:02:46Z' },
      { id: 'sub_new', status: 'active', priceIds: [NEW], nextBilledAt: '2027-02-11T05:50:33Z' },
      { id: 'sub_other_product', status: 'active', priceIds: ['pri_someone_else'], nextBilledAt: '2026-11-21T06:07:59Z' },
    ]);

    const report = await switchRenewalPrice(config, { apply: false, fetch: paddle.fetch });

    expect(report).toEqual([
      {
        subscriptionId: 'sub_old',
        outcome: 'would-change',
        nextBilledAt: '2027-10-30T09:02:46Z',
        nextTotal: '48.00 USD',
      },
    ]);
    expect(paddle.changes()).toEqual([]);
  });

  it('with apply, swaps the item to the new price without billing now', async () => {
    const paddle = fakePaddle([{ id: 'sub_old', status: 'active', priceIds: [OLD], nextBilledAt: '2027-10-30T09:02:46Z' }]);

    const report = await switchRenewalPrice(config, { apply: true, fetch: paddle.fetch });

    expect(paddle.changes()).toEqual([
      {
        method: 'PATCH',
        path: '/subscriptions/sub_old',
        body: { items: [{ price_id: NEW, quantity: 1 }], proration_billing_mode: 'do_not_bill' },
      },
    ]);
    expect(report).toEqual([
      { subscriptionId: 'sub_old', outcome: 'changed', nextBilledAt: '2027-10-30T09:02:46Z', nextTotal: '48.00 USD' },
    ]);
    // 再跑一次就沒有要改的了：重跑是安全的
    expect(await switchRenewalPrice(config, { apply: true, fetch: paddle.fetch })).toEqual([]);
  });

  it('reads every page of subscriptions and leaves canceled ones alone', async () => {
    const paddle = fakePaddle(
      [
        { id: 'sub_canceled', status: 'canceled', priceIds: [OLD], nextBilledAt: null },
        { id: 'sub_new', status: 'active', priceIds: [NEW], nextBilledAt: '2027-02-11T05:50:33Z' },
        { id: 'sub_past_due', status: 'past_due', priceIds: [OLD], nextBilledAt: '2027-03-01T00:00:00Z' },
      ],
      { pageSize: 1 },
    );

    const report = await switchRenewalPrice(config, { apply: false, fetch: paddle.fetch });

    expect(report.map((r) => r.subscriptionId)).toEqual(['sub_past_due']);
  });

  it('skips a subscription when the swap would bill now, move the billing date, or drop other items', async () => {
    const paddle = fakePaddle([
      { id: 'sub_bills_now', status: 'active', priceIds: [OLD], nextBilledAt: '2027-10-30T09:02:46Z', previewChargesNow: true },
      { id: 'sub_moves_date', status: 'active', priceIds: [OLD], nextBilledAt: '2027-10-30T09:02:46Z', previewNextBilledAt: '2026-11-11T00:00:00Z' },
      { id: 'sub_two_items', status: 'active', priceIds: [OLD, 'pri_addon'], nextBilledAt: '2027-10-30T09:02:46Z' },
    ]);

    const report = await switchRenewalPrice(config, { apply: true, fetch: paddle.fetch });

    expect(report.map((r) => [r.subscriptionId, r.outcome])).toEqual([
      ['sub_bills_now', 'skipped'],
      ['sub_moves_date', 'skipped'],
      ['sub_two_items', 'skipped'],
    ]);
    expect(report.every((r) => r.reason)).toBe(true);
    expect(paddle.changes()).toEqual([]);
  });
});

describe('switchRenewalPrice with only', () => {
  it('touches just the named subscription', async () => {
    const paddle = fakePaddle([
      { id: 'sub_a', status: 'active', priceIds: [OLD], nextBilledAt: '2027-10-30T09:02:46Z' },
      { id: 'sub_b', status: 'active', priceIds: [OLD], nextBilledAt: '2027-10-30T10:59:10Z' },
    ]);

    const report = await switchRenewalPrice(config, { apply: true, only: 'sub_b', fetch: paddle.fetch });

    expect(report.map((r) => [r.subscriptionId, r.outcome])).toEqual([['sub_b', 'changed']]);
    expect(paddle.changes().map((r) => r.path)).toEqual(['/subscriptions/sub_b']);
  });
});
