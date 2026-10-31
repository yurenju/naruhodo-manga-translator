/**
 * Paddle（Merchant of Record，spec #86「Worker API」、#94、#95）：Worker 對 Paddle API 的三個呼叫，以及驗 webhook 的簽章。
 * env.test（browser test）的 __FAKE_PADDLE__ 換成假的實作，不碰真的 Paddle；Worker 測試用 env.dev，Paddle API 用 vi.spyOn(fetch) 假的。
 */
import type { CancelTiming } from './subscription.ts';

type Env = Cloudflare.Env;

/** Paddle API 失敗（非 2xx、連不上、回應格式不對）。 */
export class PaddleError extends Error {}

export interface Paddle {
  /** 建立年繳 price 的 transaction，custom_data 放 Account id；回傳 transaction id（checkout 頁用 `_ptxn` 打開）。 */
  createTransaction(accountId: string): Promise<string>;
  /** 替這個 customer 建立 customer portal session（取消訂閱、更新付款方式、收據），回傳網址。 */
  portalUrl(customerId: string, subscriptionId: string): Promise<string>;
  /** 刪除帳號時取消訂閱，不退款；什麼時候生效由 subscription.ts 的 cancellationOnDelete 決定。 */
  cancelSubscription(subscriptionId: string, timing: CancelTiming): Promise<void>;
}

export function paddle(env: Env): Paddle {
  return __FAKE_PADDLE__ ? fakePaddle(env) : paddleApi(env);
}

function paddleApi(env: Env): Paddle {
  async function call<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${env.PADDLE_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.PADDLE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new PaddleError(`連不上 Paddle：${e instanceof Error ? e.message : String(e)}`);
    }
    // 錯誤回應的內容只用來除錯，不回給 client
    if (!response.ok) throw new PaddleError(`Paddle API ${path} 失敗：HTTP ${response.status}`);
    return ((await response.json()) as { data: T }).data;
  }

  return {
    async createTransaction(accountId) {
      const { id } = await call<{ id?: string }>('/transactions', {
        items: [{ price_id: env.PADDLE_PRICE_ID, quantity: 1 }],
        custom_data: { account_id: accountId },
      });
      if (!id) throw new PaddleError('Paddle 沒有回傳 transaction id');
      return id;
    },
    async portalUrl(customerId, subscriptionId) {
      const { urls } = await call<{ urls?: { general?: { overview?: string } } }>(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
        subscription_ids: [subscriptionId],
      });
      const url = urls?.general?.overview;
      if (!url) throw new PaddleError('Paddle 沒有回傳 customer portal 網址');
      return url;
    },
    async cancelSubscription(subscriptionId, timing) {
      await call(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { effective_from: timing });
    },
  };
}

/** 假 Paddle 拒絕替這個 customer 建立 portal session：browser test 的 webhook 用這個 customer id，模擬 key 少了權限（#156）。 */
const FAKE_PORTAL_FORBIDDEN_CUSTOMER = 'ctm_fake_portal_forbidden';

/** browser test 的假 Paddle：transaction id 帶 Account id（測試從 checkout 網址取出來組 webhook 事件）。 */
function fakePaddle(env: Env): Paddle {
  return {
    createTransaction: async (accountId) => `txn_fake_${accountId}`,
    async portalUrl(customerId) {
      if (customerId === FAKE_PORTAL_FORBIDDEN_CUSTOMER) throw new PaddleError(`Paddle API /customers/${customerId}/portal-sessions 失敗：HTTP 403`);
      return `${env.SITE_ORIGIN}/zh-tw/?fake-portal=${encodeURIComponent(customerId)}`;
    },
    cancelSubscription: async () => {},
  };
}

/** 簽章的 ts 跟現在差超過這麼多就不收（擋住把攔到的舊請求重送）。 */
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

const hexBytes = (hex: string): Uint8Array | undefined =>
  /^(?:[0-9a-f]{2})+$/i.test(hex) ? new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16))) : undefined;

/**
 * 驗 `Paddle-Signature: ts=<秒>;h1=<hex>`：HMAC-SHA256(secret, `${ts}:${原始 body}`)，用 Web Crypto 的 timing-safe 比較。
 * secret rotation 時可能同時有多個 h1，任一個對就算。
 */
export async function verifyWebhook(secret: string, header: string, body: string, now: number): Promise<boolean> {
  const parts = header.split(';').map((part) => part.split('='));
  const ts = parts.find(([k]) => k === 'ts')?.[1] ?? '';
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts) * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`));
  return parts.some(([k, v]) => {
    const actual = k === 'h1' && v ? hexBytes(v) : undefined;
    return actual !== undefined && actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
  });
}
