/** wrangler.jsonc 的 define：env.test 是 true，Anthropic 換成 FakeTranslator；其他是 false，整段不會打包。 */
declare const __FAKE_ANTHROPIC__: boolean;
/** 同上：env.test 是 true，Paddle API 換成 paddle.ts 的假實作。 */
declare const __FAKE_PADDLE__: boolean;

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** 寄送驗證碼的頻率限制（Workers Rate Limiting），key 分別是 IP 與 email。 */
    SEND_CODE_BY_IP: RateLimit;
    SEND_CODE_BY_EMAIL: RateLimit;
    /** 驗證驗證碼的頻率限制，key 分別是 IP 與 email（一小時內的驗證次數另外記在 D1，見 auth.ts）。 */
    VERIFY_CODE_BY_IP: RateLimit;
    VERIFY_CODE_BY_EMAIL: RateLimit;
    /** 猜作品原名（#186）的頻率限制，key 是 Account id：大約每一話一次，正常閱讀遠低於上限。 */
    SERIES_GUESS_BY_ACCOUNT: RateLimit;
    /** "true"：寄信用假的實作，並開放 DEV_OUTBOX_PATH（只有 env.dev／env.test 設）。 */
    FAKE_MAIL?: string;
    /** "true"：開放開發用的端點（DEV_FREE_PAGES_PATH）；只有 env.dev／env.test 設。 */
    DEV_ENDPOINTS?: string;
    /** Resend 的 key（production 用 wrangler secret）與寄件地址（wrangler.jsonc 的 vars）。 */
    RESEND_API_KEY?: string;
    MAIL_FROM?: string;
    /** 呼叫 Anthropic 的 key：production 用 wrangler secret，本機由 op run 放進 wrangler 的 env（npm run worker:dev，#175）。 */
    CLAUDE_API_KEY?: string;
    /** 訂閱者每月可翻的頁數（wrangler.jsonc 的 vars，起始 800）；調整不用發新版外掛。 */
    MONTHLY_PAGE_LIMIT: string;
    /** checkout 頁所在的產品網站 origin（Worker 組 `<origin>/<locale>/checkout?_ptxn=…`）。 */
    SITE_ORIGIN?: string;
    /** Paddle API：網址是 vars；key、年繳 price 與 webhook secret 用 wrangler secret，本機從 ~/.config/naruhodo/paddle-sandbox.env 讀。 */
    PADDLE_API_BASE_URL: string;
    PADDLE_API_KEY?: string;
    PADDLE_PRICE_ID?: string;
    /** webhook 的 HMAC key（`pdl_ntfset_…`，原樣使用）。 */
    PADDLE_WEBHOOK_SECRET?: string;
  }

  /** 讓測試的 `exports.default`（cloudflare:workers）有 Worker 入口的型別。 */
  interface GlobalProps {
    mainModule: typeof import('./index.ts');
  }
}
