/**
 * email 驗證碼登入與帳號狀態的 client（#91、#92、#94、#95）：onboarding 的登入步驟呼叫 Worker 寄送與驗證驗證碼；side panel 讀目前的
 * 帳號狀態（剩餘額度）；「訂閱」建立 checkout、「管理訂閱」建立 customer portal session，拿到網址由呼叫的一方用新分頁打開；「申請退款」（#260）；
 * 設定頁的登出與刪除帳號（之後清掉本機 session 的流程在 account-exit.ts）。
 * 回傳 Worker 給的錯誤原因，畫面依原因換文案；連不上 Worker 時 reason 是 undefined。
 */
import {
  ACCOUNT_PATH,
  CHECKOUT_PATH,
  PORTAL_PATH,
  REFUND_PATH,
  SEND_CODE_PATH,
  SIGN_OUT_PATH,
  VERIFY_CODE_PATH,
  bearerHeader,
  readHostedError,
  type AccountResponse,
  type BillingPeriod,
  type CheckoutLocale,
  type CheckoutRequest,
  type CheckoutResponse,
  type HostedErrorReason,
  type PortalResponse,
  type VerifyCodeResponse,
} from './hosted-api.ts';

export type AuthFailure = { ok: false; reason: HostedErrorReason | undefined; message: string };

export interface HostedAccountClient {
  sendCode(email: string): Promise<{ ok: true } | AuthFailure>;
  verifyCode(email: string, code: string): Promise<{ ok: true; token: string } | AuthFailure>;
  /** 帶 session token 讀目前的帳號狀態。 */
  account(token: string): Promise<{ ok: true; account: AccountResponse } | AuthFailure>;
  /** 建立這個 Billing Period 的 Subscription 的 checkout，回傳產品網站 checkout 頁的網址（locale 是頁面語言）。 */
  checkout(token: string, locale: CheckoutLocale, billingPeriod: BillingPeriod): Promise<{ ok: true; url: string } | AuthFailure>;
  /** 建立 Paddle customer portal session，回傳網址。 */
  portal(token: string): Promise<{ ok: true; url: string } | AuthFailure>;
  /** 替最近一次扣款申請全額退款（#260）；不能退時 reason 是 refund* 的原因。 */
  refund(token: string): Promise<{ ok: true } | AuthFailure>;
  /** 撤銷這個 session token。 */
  signOut(token: string): Promise<{ ok: true } | AuthFailure>;
  /** 刪除這個 Account（Worker 先取消訂閱）。 */
  deleteAccount(token: string): Promise<{ ok: true } | AuthFailure>;
}

export function createHostedAccountClient({ apiUrl, fetch }: { apiUrl: string; fetch: (url: string, init: RequestInit) => Promise<Response> }): HostedAccountClient {
  async function send(path: string, init: RequestInit): Promise<{ ok: true; response: Response } | AuthFailure> {
    let response: Response;
    try {
      response = await fetch(apiUrl + path, init);
    } catch (e) {
      return { ok: false, reason: undefined, message: e instanceof Error ? e.message : String(e) };
    }
    if (response.ok) return { ok: true, response };
    const error = await readHostedError(response);
    return { ok: false, reason: error.reason, message: error.error };
  }

  const post = (path: string, body: unknown, token?: string) =>
    send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : bearerHeader(token)) },
      body: JSON.stringify(body),
    });

  async function url(path: string, body: unknown, token: string): Promise<{ ok: true; url: string } | AuthFailure> {
    const result = await post(path, body, token);
    if (!result.ok) return result;
    return { ok: true, url: ((await result.response.json()) as CheckoutResponse | PortalResponse).url };
  }

  return {
    async sendCode(email) {
      const result = await post(SEND_CODE_PATH, { email });
      return result.ok ? { ok: true } : result;
    },
    async verifyCode(email, code) {
      const result = await post(VERIFY_CODE_PATH, { email, code });
      if (!result.ok) return result;
      const { token } = (await result.response.json()) as VerifyCodeResponse;
      return { ok: true, token };
    },
    async account(token) {
      const result = await send(ACCOUNT_PATH, { headers: bearerHeader(token) });
      if (!result.ok) return result;
      return { ok: true, account: (await result.response.json()) as AccountResponse };
    },
    checkout: (token, locale, billingPeriod) => url(CHECKOUT_PATH, { locale, billingPeriod } satisfies CheckoutRequest, token),
    portal: (token) => url(PORTAL_PATH, {}, token),
    async refund(token) {
      const result = await post(REFUND_PATH, {}, token);
      return result.ok ? { ok: true } : result;
    },
    async signOut(token) {
      const result = await post(SIGN_OUT_PATH, {}, token);
      return result.ok ? { ok: true } : result;
    },
    async deleteAccount(token) {
      const result = await send(ACCOUNT_PATH, { method: 'DELETE', headers: bearerHeader(token) });
      return result.ok ? { ok: true } : result;
    },
  };
}
