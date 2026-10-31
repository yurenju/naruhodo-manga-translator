/**
 * 外掛與 Worker 之間的 API 契約（spec #86「Worker API」）：路徑、請求與回應的形狀、錯誤。外掛的 Hosted Translation Translator、
 * 登入畫面與 Worker 都 import 這一份。
 *
 * 翻譯與 Notes：body 是 TranslateInput／NotesInput 原樣（結構化輸入，不是 prompt）；回應是 TranslateOutput／NotesOutput
 * （latencyMs 只算 Worker 到 Anthropic，外掛換成自己量的）。翻譯回應帶 usageRecordId，同一頁的 Notes 請求放在 pageUsageRecordId 帶回來，
 * Notes 的用量就歸到這一頁。直式捲動的長 Page（spec #142）的接續翻譯也用 pageUsageRecordId 帶回來：Worker 在條件內
 * （同一個 Account、1 小時內、接續 ≤ 10 次）只記用量、不扣頁，回應的 usageRecordId 還是那一筆；條件不符就扣一頁、回新的。
 * 要帶 `Authorization: Bearer <session token>`。
 *
 * 錯誤回應一律是 HostedError：401 沒登入（reason signedOut）、400 輸入格式不符或驗證碼不對、402 額度用完、
 * 413 body 超過 256 KiB、429 寄送或驗證太頻繁、404 沒有這個端點、502 Anthropic 重試後仍失敗。
 */
export const TRANSLATE_PATH = '/v1/translate';
export const NOTES_PATH = '/v1/notes';

/** POST { email }：寄出 6 位數驗證碼，204。 */
export const SEND_CODE_PATH = '/v1/auth/send-code';
/** POST { email, code }：驗證成功回 VerifyCodeResponse；第一次驗證成功時建立 Account。 */
export const VERIFY_CODE_PATH = '/v1/auth/verify';
/** POST（帶 token）：撤銷這個 token，204。 */
export const SIGN_OUT_PATH = '/v1/auth/sign-out';
/**
 * GET（帶 token）：目前的 Account 狀態 AccountResponse。
 * DELETE（帶 token）：刪除帳號，204。有訂閱的先取消 Paddle 訂閱（不退款；active 到扣款週期結束才失效，扣款失敗中或暫停的立即取消），取消失敗回 502 且什麼都不刪；
 * 之後刪除 Account、所有 session（每個 token 都失效）、額度、用量紀錄、訂閱，只保留 email hash（Free Pages 領取紀錄）。
 */
export const ACCOUNT_PATH = '/v1/account';
/**
 * GET ?email=：假的寄信實作最後寄給這個 email 的驗證碼 { code }。只有 FAKE_MAIL 的 env（dev、test）有，
 * browser test 與本機開發用它代替收信；production 一律 404。
 */
export const DEV_OUTBOX_PATH = '/v1/dev/outbox';
/**
 * POST { email, remaining }：把這個 email 的 Account 的免費額度改成 remaining 頁，204。只有 DEV_ENDPOINTS 的 env（dev、test）有，
 * browser test 與本機開發用它試「快用完」「用完」的畫面；production 一律 404。
 */
export const DEV_FREE_PAGES_PATH = '/v1/dev/free-pages';

/**
 * POST { locale }（帶 token）：用 Paddle API 建立年繳 Subscription 的 transaction（custom_data 放這個 Account 的 id，
 * client 指定不了），回傳 CheckoutResponse：產品網站 checkout 頁的網址，外掛用新分頁打開。已經訂閱中回 409 alreadySubscribed。
 */
export const CHECKOUT_PATH = '/v1/checkout';
/** POST（帶 token）：用 Paddle API 替這個 Account 的 customer 建立 customer portal session，回傳 PortalResponse；沒訂閱過回 404。 */
export const PORTAL_PATH = '/v1/subscription/portal';
/** Paddle 送 webhook 的路徑（不帶 token，驗 Paddle-Signature）。 */
export const PADDLE_WEBHOOK_PATH = '/webhooks/paddle';
/** GET：Worker 與 D1 都能用就回 200 { ok: true }。部署後的健康檢查用（.github/workflows/ci.yml），外掛不呼叫。 */
export const HEALTH_PATH = '/v1/health';

/** checkout 頁的語言（產品網站的 /zh-tw/、/en/）。 */
export type CheckoutLocale = 'zh-tw' | 'en';

export interface CheckoutResponse {
  url: string;
}

export interface PortalResponse {
  url: string;
}

export interface VerifyCodeResponse {
  /** 長期有效的 session token；每次使用都會延長期限。 */
  token: string;
}

/** 新 Account 一次性的免費頁數（Worker 發額度、設定頁顯示「剩 N / 50 頁」）。 */
export const FREE_PAGES = 50;

/**
 * 剩餘額度（spec #86「額度規則」）。外掛只顯示這裡的數字，不自己算。
 * - free：沒有訂閱（包含訂閱結束後），remaining 是剩下的 Free Pages
 * - subscribed：訂閱中（`active`，包含排定取消，以及扣款失敗重試中的 `past_due`）。remaining 是本月剩餘頁數，
 *   Free Pages 不動也不顯示。時間都是 Unix 毫秒
 */
export type Quota =
  | { plan: 'free'; remaining: number }
  | {
      plan: 'subscribed';
      remaining: number;
      /** Monthly Page Limit（Worker 的設定值）。 */
      limit: number;
      /** 下次重置本月額度的時間：從訂閱開始日起每個月同一天，沒有那一天的月份是月底。 */
      resetsAt: number;
      /** pastDue＝扣款失敗、Paddle 重試中（照常可以用）。 */
      status: 'active' | 'pastDue';
      /** 排定取消：這一年結束時不續訂。 */
      cancelScheduled: boolean;
      /** 這一年的結束：下次續訂日，排定取消時是訂閱結束日。 */
      periodEndsAt: number;
    };

export interface AccountResponse {
  email: string;
  quota: Quota;
}

/**
 * 外掛要依原因換畫面的錯誤：
 * - signedOut：沒帶 token、token 錯誤、過期或已撤銷
 * - rateLimited：寄送或驗證太頻繁（依 IP 與 email），或同一個 email 一小時內驗證太多次
 * - wrongCode／codeExpired／tooManyAttempts：驗證碼錯、過期（或沒寄過）、錯太多次這組已失效
 * - freePagesExhausted：沒有訂閱、免費額度用完（402）；訂閱結束後免費額度也是 0 的也是這個
 * - monthlyLimitReached：訂閱中、本月額度用完（402）；重置日期在 GET /v1/account 的 quota.resetsAt
 * - alreadySubscribed：已經訂閱中，不再建立 checkout（409）
 */
export type HostedErrorReason =
  | 'signedOut'
  | 'rateLimited'
  | 'wrongCode'
  | 'codeExpired'
  | 'tooManyAttempts'
  | 'freePagesExhausted'
  | 'monthlyLimitReached'
  | 'alreadySubscribed';

export interface HostedError {
  error: string;
  reason?: HostedErrorReason;
}

/** 帶 session token 的標頭（翻譯、Notes 與帳號相關的端點都要）。 */
export const bearerHeader = (token: string) => ({ authorization: `Bearer ${token}` });

/** 讀 Worker 的錯誤回應；body 不是 HostedError（例如 Cloudflare 自己的錯誤頁）就用 HTTP 狀態碼當訊息。 */
export async function readHostedError(response: Response): Promise<HostedError> {
  const body = (await response.json().catch(() => ({}))) as Partial<HostedError>;
  return { error: body.error ?? `HTTP ${response.status}`, ...(body.reason ? { reason: body.reason } : {}) };
}
