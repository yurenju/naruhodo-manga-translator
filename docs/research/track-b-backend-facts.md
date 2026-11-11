# Track B 後端事實查核：Cloudflare、Paddle、Chrome 外掛登入

> 查核日期：2026-10-28。資料來自 Cloudflare、Paddle、Chrome、AWS、Resend、Postmark 的官方文件與定價頁。價格與限制會變，實作前請再看一次原始頁面。
> 標「推論」的段落是根據文件拼出的結論，文件本身沒有直接寫。

背景：開源的 Chrome MV3 外掛（日文漫畫翻譯）要加付費方案。Cloudflare Worker 轉發 Anthropic API；使用者用 email 註冊，先拿免費額度，之後用 Paddle Billing 訂閱。side panel 和 offscreen document 會 fetch 這個 Worker。

---

## 1. 從 Cloudflare Worker 寄交易型 email（驗證碼／magic link）

### 1.1 Cloudflare 自己的選項：Email Service（Email Sending）

- **狀態**：對外寄信的 Email Sending 目前是 **beta**。
  來源：https://developers.cloudflare.com/email-service/
- **方案**：要寄給任意收件人，必須用 **Workers Paid**。Workers Free 不能對外寄信，只能寄給帳號內「已驗證的目的地地址」，這部分免費。
  來源：https://developers.cloudflare.com/email-service/platform/pricing/
- **價格**：Workers Paid 每月含 **3,000 封**，超過後 **每 1,000 封 $0.35**。額度以帳號為單位、跟著帳單週期重置。hard bounce 和已被 Email Service 接受的信都算額度；在 API 層就被拒的（包括被 suppression list 擋掉的）不算。寄給已驗證目的地的信不算額度。
  來源：https://developers.cloudflare.com/email-service/platform/pricing/
- **能不能寄給任意收件人**：sending domain 還沒 onboard 之前，只能寄給已驗證的目的地；**onboard sending domain 之後可以寄給任何收件人**。寄件人只能用自己的 routing domain。
  來源：https://developers.cloudflare.com/email-service/platform/limits/ 、 https://developers.cloudflare.com/email-routing/limits/
- **每日上限**：新帳號起始的每日額度很保守，之後依寄信行為、送達率和帳號狀態逐步調高。數字沒有公開，要提高可以填 Limit Increase Request Form。
  來源：https://developers.cloudflare.com/email-service/platform/limits/
- **單封限制**：to/cc/bcc 合計最多 50 人；主旨最長 998 字元；整封（含附件）5 MiB；自訂 header 合計 16 KB。
  來源：https://developers.cloudflare.com/email-service/platform/limits/
- **從 Worker 呼叫**：在 wrangler 設定 `send_email` binding，再呼叫 `env.EMAIL.send({ to, from, subject, html, text })`，回傳值有 `messageId`。錯誤會丟出帶 `code` 的例外，例如 `E_SENDER_NOT_VERIFIED`。binding 可以用 `allowed_destination_addresses` 之類的屬性限制收件人，違反時回 `E_RECIPIENT_NOT_ALLOWED`。
  來源：https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/
- **監控陷阱**：用 `send_email` binding 寄出的信，在 Email Routing summary 裡會顯示成「dropped」，就算實際寄到了也一樣。要看 Email sending 的 metrics 和 logs 才準。
  來源：https://developers.cloudflare.com/email-routing/limits/
- **合規**：要遵守 CAN-SPAM、GDPR、CASL 等反垃圾信規範。這是搜尋摘要的內容，實作前請在 Email Service 文件裡確認原文。

### 1.2 第三方服務比較

| 服務 | 免費額度 | 最低付費 | 從 Worker 呼叫 |
|---|---|---|---|
| **Cloudflare Email Service** | Free 方案不能對外寄信 | 包含在 Workers Paid（$5/月）裡：3,000 封/月，之後 $0.35/千封 | 原生 `send_email` binding，不需要 API key |
| **Resend** | 3,000 封/月，**每天上限 100 封**，3 個網域 | Pro $20/月 50,000 封（沒有每日上限） | `POST https://api.resend.com/emails`，header 帶 `Authorization: Bearer re_...`，必填 `from`/`to`/`subject`；官方也有 Workers 用的 SDK 教學 |
| **Postmark** | Developer 方案 100 封/月，不能超量 | Basic $15/月 10,000 封，超量 $1.80/千封 | `POST https://api.postmarkapp.com/email`，header 帶 `X-Postmark-Server-Token`；`From` 必須是已確認的 sender signature |
| **Amazon SES** | 新客戶最多 $200 Free Tier credits（6 個月內有效，credits 要在 12 個月內用掉） | à la carte $0.10/千封 | `POST /v2/email/outbound-emails`（SES API v2），要用 AWS SigV4 簽章（推論：Worker 裡要自己簽，或用支援 SigV4 的 fetch 函式庫） |

來源：
- Resend 定價：https://resend.com/pricing ；API：https://resend.com/docs/api-reference/emails/send-email ；Workers 教學：https://resend.com/docs/send-with-cloudflare-workers
- Postmark 定價：https://postmarkapp.com/pricing ；API：https://postmarkapp.com/developer/user-guide/send-email-with-api
- SES 定價：https://aws.amazon.com/ses/pricing/ ；API：https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- **SES sandbox**：新帳號一律在 sandbox。sandbox 裡只能寄給已驗證的地址，**每 24 小時最多 200 封、每秒 1 封**。要脫離 sandbox 得申請 production access，AWS 會在 96 小時內給第一次回覆。
  來源：https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html

### 對設計的意涵
- 後端反正要用 Workers Paid（理由見第 3 節的 CPU time），所以 Cloudflare Email Service 等於多拿 3,000 封/月、不用額外的 API key。缺點是它還在 beta，而且新帳號的每日上限沒有公開。
- 驗證碼信的量大約等於登入次數。Resend 免費方案每天只能寄 100 封，上架初期一波流量就可能被卡住。建議把寄信包成一個介面，先用 Cloudflare，必要時換成 Resend 或 Postmark。
- 不管用哪家，都要先設定 sending domain 的 DNS 驗證，而且要在 Worker 端限制寄信頻率，避免被拿來轟炸別人的信箱（見第 3 節的 Rate Limiting）。

---

## 2. Cloudflare D1 與 Durable Objects（額度計數器）

### 2.1 D1 限制與價格

| 項目 | Workers Free | Workers Paid |
|---|---|---|
| 讀取列數 | 每天 500 萬 | 每月含 250 億，之後 $0.001/百萬 |
| 寫入列數 | **每天 10 萬** | 每月含 5,000 萬，之後 $1.00/百萬 |
| 儲存量 | 共 5 GB | 含 5 GB，之後 $0.75/GB-月 |
| 單一資料庫大小 | 500 MB | 10 GB |
| 每次 Worker 呼叫可下的 query 數 | 50 | 1,000 |
| 單一 query 時間 | 30 秒 | 30 秒 |

- Free 方案的限制是硬上限：超過每日讀寫上限之後 query 會失敗，直到 00:00 UTC 重置。
  來源：https://developers.cloudflare.com/d1/platform/pricing/ 、 https://developers.cloudflare.com/d1/platform/limits/
- `db.batch()` 對「每次呼叫的 query 數」只算一次，但裡面每條 statement 仍各自受單一 query 的限制。
  來源：https://developers.cloudflare.com/d1/platform/limits/

### 2.2 交易與原子性

- **`batch()` 就是 SQL 交易**：多條 statement 依序執行；其中一條失敗，整批 abort 或 rollback。其他情況下 D1 以 auto-commit 模式運作。
  來源：https://developers.cloudflare.com/d1/worker-api/d1-database/
- **不支援 `BEGIN TRANSACTION`**：官方 API 文件只描述 batch 這一種交易機制。Cloudflare 部落格的說法是：SQLite 同時只能有一個寫入交易，如果開放 BEGIN，一個 Worker 請求就能卡住所有寫入（這點來自搜尋摘要，第三方文章也這麼說）。
  來源：https://blog.cloudflare.com/whats-new-with-d1/
- **每個 D1 資料庫本質上是單執行緒，一次處理一個 query**。吞吐量跟 query 耗時直接相關：每個 query 平均 1 ms，上限約每秒 1,000 個 query。請求太多時會先排隊，佇列滿了就回「overloaded」錯誤。
  來源：https://developers.cloudflare.com/d1/platform/limits/ 、 https://developers.cloudflare.com/d1/reference/faq/
- **「額度減 1，但不能低於 0」**（推論）：因為 D1 一次只跑一個 query，只要把條件和更新寫在**同一條** SQL 裡，就不會 race：
  ```sql
  UPDATE quota SET remaining = remaining - 1
  WHERE user_id = ? AND remaining > 0;
  ```
  再用結果的 `meta.changes` 判斷：`1` 是扣款成功，`0` 是額度不足。千萬不要「先 SELECT，在 JS 裡判斷，再 UPDATE」，兩個步驟之間會被其他請求插隊。`RETURNING` 是 SQLite 的語法，但 D1 文件沒有明確寫支援；要用的話請先實測。
- **Read replication**：開了 read replica 之後，寫入一律轉給 primary；Sessions API 提供 sequential consistency（read-my-own-writes 等）。文件沒有提到 serializable isolation。
  來源：https://developers.cloudflare.com/d1/best-practices/read-replication/

### 2.3 Durable Objects

- **Free 方案也能用**，但只能用 SQLite backend。
  - Free：請求每天 10 萬、duration 每天 13,000 GB-s、SQLite 讀取每天 500 萬列、寫入每天 10 萬列、儲存共 5 GB。
  - Paid：請求每月含 100 萬，之後 $0.15/百萬；duration 每月含 400,000 GB-s，之後 $12.50/百萬 GB-s；SQLite 讀寫的價格跟 D1 一樣；儲存 $0.20/GB-月。
  來源：https://developers.cloudflare.com/durable-objects/platform/pricing/
- **保證**：每個 object 全球唯一、單執行緒（cooperative multitasking）、儲存是強一致的，而且跟運算放在同一處。
  來源：https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- **原子性**：每個 storage 方法都自動包在交易裡；一次讀取之後接著寫入，只要中間沒有其他 I/O，行為就等同一個交易，因為 input gate 會暫停其他事件。SQLite backend 另外有 `transactionSync()`，callback 丟例外就 rollback。output gate 會等寫入落盤之後，才把回應送出去。
  來源：https://developers.cloudflare.com/durable-objects/api/storage-api/
- **限制**：每個 object 的軟上限是每秒 1,000 個請求；object 數量沒有上限；每次請求的 CPU 預設 30 秒，可以調到 5 分鐘。
  來源：https://developers.cloudflare.com/durable-objects/platform/limits/
- 官方的 Rate Limiting 文件也建議：要嚴格的全域限流，就用 Durable Objects，每個 credential 一個 object（見第 3.3 節）。

### 2.4 用哪個當每位使用者的額度計數器？（推論）

| | D1 條件式 UPDATE | 每位使用者一個 DO |
|---|---|---|
| 正確性 | 單一資料庫一次跑一個 query，單條 `UPDATE ... WHERE remaining > 0` 就是原子的 | 單執行緒加 input gate，天生不會 race |
| 規模天花板 | 所有使用者共用一個資料庫的寫入吞吐（query 約 1 ms 時大約每秒 1,000 個） | 每位使用者各自有每秒 1,000 個請求，整體可以水平擴展 |
| 查詢與報表 | 一般 SQL 就能跨使用者查詢、對帳 | 資料分散在各個 object 裡，跨使用者查詢很麻煩 |
| 複雜度 | 低 | 要多寫一個 DO class，還要處理 migration |

以這個專案的規模（每次翻譯只扣一次額度），**D1 加條件式 UPDATE 就夠了**。使用者、訂閱狀態、webhook event_id 去重也都可以放在同一個 D1。等寫入量逼近單一資料庫的天花板，或需要「扣款、呼叫 API、失敗退款」這種有狀態的流程時，再考慮 DO。

### 對設計的意涵
- 額度扣減要用單條條件式 UPDATE（或 DO），不要讀出來改完再寫回去；`batch()` 可以把「扣額度、寫 usage log」包成同一個交易。
- 在 Free 方案上，D1 每天只能寫 10 萬列，計數器、登入碼、log 都會用到這個額度。上線就應該用 Paid。
- 先扣後退還是先呼叫再扣？Anthropic 呼叫失敗時要不要退回額度，需要明確決定，因為 D1 沒辦法跨 fetch 持有交易。

---

## 3. Cloudflare Workers 的限制

### 3.1 CPU time、wall time、subrequest

| 項目 | Workers Free | Workers Paid |
|---|---|---|
| 每個 HTTP 請求的 CPU time | **10 ms** | 預設 30 秒，最多 5 分鐘 |
| Duration（wall time） | HTTP 請求沒有上限 | 同左 |
| 每個請求的 subrequest | 50 | 10,000（可以提高到 1,000 萬） |
| 記憶體 | 每個 isolate 128 MB | 同左 |
| 每日請求數 | 10 萬（00:00 UTC 重置，超過回 Error 1027） | 沒有上限 |
| 同時等待回應 header 的連線數 | 6 | 6 |

- **等待網路 I/O（`fetch()`、KV、資料庫）的時間不算 CPU time。**
- 只要 client 還連著，HTTP 觸發的 Worker 就沒有 duration 上限，可以繼續處理、發 subrequest、串流回應。**client 一斷線，跟這個請求相關的工作（包括還沒完成的 subrequest）可能會被取消。** `ctx.waitUntil()` 可以在回應送出或斷線後再延長最多 30 秒。
  來源：https://developers.cloudflare.com/workers/platform/limits/

**轉發一個 3–10 秒的 Anthropic 請求**（推論）：這段時間幾乎都在等網路，是 wall time，不是 CPU time，所以 wall time 不受限制，CPU 只花在解析和組 JSON 上。要注意的是：
1. Free 方案的 10 ms CPU 上限，碰上大的 base64 圖片 request body（JSON parse／stringify）可能不夠。上 Paid 比較保險。
2. 外掛的 side panel 關掉、offscreen document 被回收，都等於 client 斷線，Anthropic 請求可能會被取消。如果「扣額度」寫在回應之後，就要放進 `waitUntil`，或改成先扣後退。
3. 直接把 Anthropic 的 response body 串流回去，就不必在 Worker 裡把整個結果讀進記憶體。

### 3.2 Workers Paid 價格

- 每個帳號每月最低 **$5**。含 1,000 萬次請求，之後 $0.30/百萬；含 3,000 萬 CPU-ms，之後 $0.02/百萬 CPU-ms。
- Free：每天 10 萬次請求。
  來源：https://developers.cloudflare.com/workers/platform/pricing/

### 3.3 Rate Limiting binding

- 在 wrangler 設定 `ratelimits`，填 `name`、`namespace_id`，以及 `simple: { limit, period }`。**`period` 只能是 10 或 60 秒**。需要 wrangler v4.36.0 以上。
- 呼叫 `env.MY_RATE_LIMITER.limit({ key })`，回傳 `{ success }`；`success` 是 `false` 時通常回 429。一個 Worker 可以有多個 binding，例如免費使用者和付費使用者各一個。
- key 建議用使用者 ID、API key 這類穩定的識別碼，不要用 IP（很多人可能共用同一個 IP）。
- **限制是分 Cloudflare 地點各自計算的**，不會合併成全域數字。它是近似值、最終一致：檢查時用本地快取的計數，可能超過設定的門檻。要嚴格的全域限流，官方建議用 Durable Objects。
- 文件沒有寫價格，也沒寫 Free 方案能不能用。
  來源：https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

### 對設計的意涵
- 實際上一定要用 Workers Paid（$5/月）：Free 的 10 ms CPU 和每天 10 萬次請求，撐不住一個公開的付費產品。用了 Paid，也順便打開 Email Service 對外寄信。
- Rate Limiting binding 適合用來「擋濫用」，例如寄驗證碼的頻率、每位使用者的翻譯 QPS。**它不能拿來算付費額度**，額度要用 D1 或 DO 精確計算。
- 斷線取消的行為會影響扣額度放在流程的哪個時間點，要跟第 2 節的「先扣後退」一起決定。

---

## 4. Paddle Billing

### 4.1 Checkout 開在自己的網站，把 user id 帶進去

- **MV3 不能載入遠端程式碼**：所有 JS/WASM 都要打包進外掛裡；在 extension page 加遠端 `<script>` 會被審查擋下，第一方 SDK 也一樣。文件沒有談 iframe 嵌入遠端頁面或開分頁的情況。
  來源：https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- Paddle.js 官方要求「一律從 `https://cdn.paddle.com/` 載入」，也可以用 npm 的 `@paddle/paddle-js`（推論：它在執行時仍然會從 CDN 載入 script，跟 MV3 衝突）。所以 checkout 要開在自己網站的一般分頁裡。
  來源：https://developer.paddle.com/paddlejs/include-paddlejs
- **初始化**：先呼叫 `Paddle.Environment.set("sandbox")`（只在 sandbox 用，正式上線前要拿掉），再呼叫 `Paddle.Initialize({ token })`。token 前綴 `test_` 是 sandbox，`live_` 是正式環境。
  來源：https://developer.paddle.com/paddlejs/methods/paddle-environment-set
- **方式 A：在前端傳 `customData`**
  ```js
  Paddle.Checkout.open({
    items: [{ priceId: "pri_...", quantity: 1 }],
    customer: { email: "user@example.com" },
    settings: { displayMode: "overlay", successUrl: "https://example.com/thanks" },
    customData: { user_id: "u_123" },
  });
  ```
  `customData` 必須是合法的 JSON、至少一個 key，會存到 transaction 上；**如果是訂閱商品，會再複製到 subscription**。`displayMode` 可以是 `overlay`（預設）或 `inline`（inline 需要指定 `frameTarget`）。
  來源：https://developer.paddle.com/paddlejs/methods/paddle-checkout-open
- **方式 B（推論，比較安全）：由後端建立 transaction**。Worker 呼叫 Paddle API 的 `POST /transactions`，帶上 `custom_data`，再拿到 `checkout.url`（也就是 default payment link 加上 `?_ptxn=txn_...`）。這個網址所在的頁面只要載入了 Paddle.js，就會**自動打開該 transaction 的 checkout**。也可以用 `Paddle.Checkout.open({ transactionId })`。這樣 user_id 是伺服器寫進去的，使用者在瀏覽器裡改不到。
  來源：https://developer.paddle.com/build/transactions/pass-transaction-checkout/ 、 https://developer.paddle.com/build/transactions/default-payment-link/
- **custom data 的流向**：transaction 的資料會複製到它建立的 subscription；subscription 的資料會再複製到之後產生的 transaction（續訂、升降級等）。官方建議不要用巢狀結構；要清掉就送 `null`。
  來源：https://developer.paddle.com/build/transactions/custom-data
- **從 webhook 拿回來**：`subscription.created` 的 payload 是完整的 subscription entity，裡面有 `custom_data`、`customer_id`、`transaction_id`（只有這個事件有）、`status`、`current_billing_period`、`scheduled_change`。
  來源：https://developer.paddle.com/webhooks/subscriptions/subscription-created/

### 4.2 Webhook 事件與簽章驗證

- **subscription 事件**：`subscription.created`、`.activated`、`.updated`（續訂、升降級、暫停、恢復、取消等狀態變化都算）、`.canceled`、`.past_due`、`.paused`、`.resumed`、`.trialing`、`.imported`。
- **transaction 事件**：`transaction.created`、`.ready`、`.billed`、`.paid`、`.completed`（訂閱商品會自動建立 subscription）、`.canceled`、`.past_due`、`.payment_failed`、`.revised`、`.updated`。
  來源：https://developer.paddle.com/webhooks/overview
- 官方建議用來開通權限的最少組合：`subscription.created`（把 ID 存到使用者底下並開通）加上 `subscription.updated`。建議存 `customer.id`、`subscription.id`、`status`、price/product id、`scheduled_change.effective_at`。
  來源：https://developer.paddle.com/build/subscriptions/provision-access-webhooks/
- **投遞語意**：
  - 至少送達一次（at-least-once），所以要用 `event_id` 去重。
  - **事件可能不按順序到達**，要用 `occurred_at` 判斷哪個是最新狀態。
  - 必須在 **5 秒內回 200**，否則會重試。sandbox 約 2 分鐘內重試 3 次；live 約 2 天內最多重試 60 次。
  來源：https://developer.paddle.com/webhooks/about/how-webhooks-work 、 https://developer.paddle.com/build/tools/sandbox
- **簽章驗證**：
  1. header 是 `Paddle-Signature: ts=1671552777;h1=<hex>`。
  2. 要簽的內容是 `ts + ":" + rawBody`。**raw body 不能做任何轉換**，所以要在 parse JSON 之前，先用 `await request.text()` 把原始字串拿出來。
  3. 用該 notification destination 的 secret 做 HMAC-SHA256（secret 原樣當 key，不要 decode），得到 hex，再跟 `h1` 做 timing-safe 比對。
  4. 檢查 `ts` 防 replay。官方 SDK 預設容許 5 秒。
  5. secret 輪替期間可能會有多個 `h1`。
  來源：https://developer.paddle.com/webhooks/signature-verification
- **在 Worker 裡用 Web Crypto 做得到**：Workers 的 `crypto.subtle` 支援 HMAC sign/verify 和 SHA-256，另外還有非標準的 `crypto.subtle.timingSafeEqual`。
  來源：https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

### 4.3 取消與訂閱狀態

- **取消預設在期末生效**（`effective_from: next_billing_period`）。這段期間狀態維持 `active`（或原本的 `past_due`），`scheduled_change` 會是 `{ action: "cancel", effective_at }`，`next_billed_at` 變成 `null`；到期才變成 `canceled`。也可以選 `immediately`，立即變成 `canceled`。**paused 的訂閱只能立即取消。**
- 生效前可以送 `PATCH scheduled_change: null` 撤銷取消；**生效後就不能復原**，只能建立新的訂閱。
  來源：https://developer.paddle.com/build/subscriptions/cancel-subscriptions
- **狀態定義**：
  - `active`：正常扣款中。
  - `trialing`：試用期，還沒扣款。
  - `past_due`：自動扣款失敗，或手動付款的發票逾期 24 小時；重試成功就回到 `active`，重試次數用完就變 `canceled`。
  - `paused`：暫停已經生效。
  - `canceled`：取消已經生效。
  來源（搜尋摘要，指向各 webhook 頁）：https://developer.paddle.com/webhooks/subscriptions/subscription-past-due/ 、 https://developer.paddle.com/api-reference/subscriptions/get-subscription/
- **官方建議的權限對應**：`trialing`／`active` 完整權限；`past_due` 保留權限並顯示提示，引導使用者去 customer portal；`paused` 沒有權限或唯讀；`canceled` 收回權限。有 `scheduled_change` 的話，保留權限到生效日。
  來源：https://developer.paddle.com/build/subscriptions/provision-access-webhooks/

### 4.4 網域審核（domain approval）要求

網站上必須容易找到：
- 產品或服務的清楚說明
- 價格資訊或價格頁（頁面還沒上線時，可以先給截圖）
- 購買後包含的主要功能
- **Terms and Conditions、Refund Policy、Privacy Policy**，三者都要能從網站導覽列點到
- Terms 裡要寫公司名稱（個人經營可以寫品牌名，但最好用法定名稱）
- 網站已上線，並且有 **HTTPS**

其他規則：
- 每個要發起 checkout 的網域和子網域都要分別送審（`app.example.com` 不會因為 `example.com` 通過就跟著通過）。只能送跟販售產品直接相關的網域。
- 大多數會自動通過；需要人工審核時，預估 5–7 個工作天。
- sandbox 不需要網域審核。
  來源：https://www.paddle.com/help/start/account-verification/what-is-domain-verification
- live 帳號的 default payment link 必須是已審核通過的網域，而且建立 transaction 之前一定要先設好 default payment link（否則會出現 `transaction_default_checkout_url_not_set` 錯誤）。
  來源：https://developer.paddle.com/build/transactions/default-payment-link/

### 4.5 Sandbox

- sandbox 是獨立的帳號，就算已經有 live 帳號也要另外註冊。產品、價格、客戶、API key 都不互通。
- sandbox 的 API key 含 `_sdbx`，client token 以 `test_` 開頭；混用 sandbox 和 live 的憑證會得到 `forbidden`。
- API base URL：sandbox 用 `https://sandbox-api.paddle.com`，live 用 `https://api.paddle.com`。
- 測試卡：`4242 4242 4242 4242`（不需 3DS）、`4000 0038 0000 0446`（需要 3DS）。持卡人姓名隨意，到期日填未來日期即可；真實卡號會被拒絕。
- sandbox 不需要網域審核；寄出的 email 只會送到帳號網域的地址；refund adjustment 每 10 分鐘自動核准一次。
- 上線時依照 go-live checklist：換憑證、重建商品目錄和 notification 設定、切換 base URL。
  來源：https://developer.paddle.com/build/tools/sandbox

### 4.6 sandbox 實測過的行為（2026-10-30）

文件沒寫、在 sandbox 試出來的：
- **核准全額退款不會取消訂閱**：訂閱照樣是 `active`，到期還會續約扣款。所以 Worker 收到 `adjustment.created` 或 `adjustment.updated`（refund 且 `approved`）時自己立即取消（`worker/src/charges.ts` 的 `refundOutcome`，#261）；notification 設定要訂閱這兩個事件。
- **後台按「全額退款」，adjustment 最上層的 `type` 是 `partial`**，只有每個 item 的 `type` 是 `full`。判斷全額要看 items，不能只看最上層。
- **`paused` 的訂閱只能立即取消**：`effective_from: next_billing_period` 回 400，要用 `immediately`。
- **cloudflared quick tunnel 約一小時後失效**：網址的 DNS 查不到，webhook 變成 `needs_retry`。重開 `scripts/paddle-tunnel.ts` 就好。

### 對設計的意涵
- 需要一個有 HTTPS 的產品網站，上面要有說明、價格、Terms、Refund、Privacy 頁面，checkout 頁也放在這裡。這是 Paddle live 審核的前提，要排進時程，最好在開發早期就送審。
- user_id 建議由 Worker 建立 transaction 時寫進 `custom_data`（方式 B），外掛只負責開分頁到 `checkout.url`。webhook 處理要做到：先驗證簽章、用 `event_id` 去重、依 `occurred_at` 判斷新舊、在 5 秒內回 200。
- 權限判斷看 `status` 加上 `scheduled_change`：期末取消的使用者到期前仍是 `active`；`past_due` 要繼續給權限，並提示使用者去更新付款方式。

---

## 5. Chrome 外掛登入：OTP 與 magic link

### 5.1 相關 API 的事實

- **`chrome.identity.launchWebAuthFlow`**：
  - 可以用在非 Google 的身分提供者。
  - redirect URL 的格式是 `https://<extension-id>.chromiumapp.org/*`，用 `getRedirectURL(path?)` 產生。provider 導向這個網址時，**視窗會關閉，並把最後的 URL 回傳給外掛**。
  - `interactive: true` 時，頁面載入完成後才顯示視窗；非 interactive 模式下有 `abortOnLoadForNonInteractive` 和 `timeoutMsForNonInteractive`（Chrome 113 以上）。
  - 需要 `identity` permission。
  來源：https://developer.chrome.com/docs/extensions/reference/api/identity
- **offscreen document 只能用 `chrome.runtime` API**，所以 `chrome.identity` 要從 side panel 或 service worker 呼叫。
  來源：https://developer.chrome.com/docs/extensions/reference/api/offscreen
- **網頁傳訊息給外掛**：在 manifest 的 `externally_connectable.matches` 列出自己的網域，網頁就能呼叫 `chrome.runtime.sendMessage(extensionId, msg)`，外掛用 `runtime.onMessageExternal` 接收。訊息只能從網頁送往外掛，反方向不行。收到的訊息要當作不可信的輸入來驗證。沒有設定 `matches` 的話，任何網頁都連不進來。
  來源：https://developer.chrome.com/docs/extensions/develop/concepts/messaging 、 https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable
- **跨來源 fetch**：extension page 和 service worker 有 `host_permissions` 就能 fetch 外部網域；content script 的請求永遠算跨來源。
  來源：https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- **存 token**：`storage.session` 只存在記憶體，預設不開放給 content script，官方建議敏感資料放這裡；但外掛重新載入、更新或瀏覽器重啟時就會清掉。`storage.local` 會持久保存，但預設開放給 content script，要用 `setAccessLevel()` 限制。
  來源：https://developer.chrome.com/docs/extensions/reference/api/storage

### 5.2 OTP（email 驗證碼）登入（推論）

流程：在 side panel 輸入 email，Worker 寄出 6 位數驗證碼，使用者把驗證碼輸入 side panel，Worker 驗證後發 session token，外掛存到 `chrome.storage`。

- **優點**：整個流程都在外掛裡完成，不必處理「token 怎麼從別的分頁回到外掛」，也用不到 `identity` 或 `externally_connectable`。
- **難點**：
  1. 使用者切去收信時，side panel 可能被關掉，所以輸入到一半的狀態（email、送出時間）要存在 storage 裡。
  2. 後端要擋暴力破解：驗證碼要有效期限、每個 email／IP 限制嘗試次數、驗證成功就作廢。
  3. 寄信本身要限流（第 3.3 節）。

### 5.3 Magic link 登入（推論）

難點：使用者是在郵件程式或 webmail 裡點連結，打開的是**一般分頁**，不是外掛，token 沒辦法直接回到外掛。可行的做法：

1. **自家網頁轉交**：連結指向自家網站（例如 `https://example.com/auth/verify?t=...`）。這個頁面向 Worker 換到 session 之後，用 `externally_connectable` 加上 `chrome.runtime.sendMessage(extensionId, ...)` 把 session 交給外掛。也可以改由自家網域上的 content script 讀取再轉交。要注意：外掛 ID 要固定；使用者如果在別的瀏覽器或手機上點連結，外掛就收不到。
2. **輪詢（類似 device code flow）**：外掛送出登入請求時，先拿到一個 `login_request_id`，然後輪詢 Worker。使用者在任何裝置點了連結，Worker 就把這個 request 標成已核准，外掛在下一次輪詢時拿到 token。這種做法跨裝置也能用，但要防止別人拿 request id 撿走 session（request id 要夠隨機、只綁定發起的那個 client、設短效期）。
3. **`launchWebAuthFlow` 不適合直接用來接 magic link**：它只會在**自己開的那個視窗**裡攔截導向 `chromiumapp.org` 的網址。使用者從郵件點開的是另一個分頁，不會被攔截；而 `*.chromiumapp.org` 在一般分頁裡也不是一個能用的網站。它真正適合的是「在視窗裡完成整個網頁登入流程，最後導回 chromiumapp.org」這類 OAuth 或網頁表單流程。比如在那個視窗裡打開自家網站的 OTP 登入頁，讓使用者在視窗內輸入驗證碼，網站最後把 token 帶在 redirect 裡導回。但這樣其實就是 OTP，只是多繞了一層視窗。

### 對設計的意涵
- 最簡單、限制最少的是 **side panel 內的 OTP**：不需要額外的 manifest 權限，也不需要網頁和外掛之間的橋接。後端要負責驗證碼的有效期、嘗試次數和寄信限流。
- 如果要用 magic link，需要自家網站加 `externally_connectable`，或改用輪詢；`launchWebAuthFlow` 只有在「整個登入都發生在它開的視窗裡」時才有用。
- session token 存在 `storage.session` 還是 `storage.local`，要在安全性和「重啟瀏覽器要不要重新登入」之間取捨；選 `local` 的話，記得用 `setAccessLevel()` 擋掉 content script。

---

## 附：每節一句話結論

1. **Email**：Cloudflare Email Service 在 Workers Paid 下可以寄給任意收件人（每月含 3,000 封，之後 $0.35/千封），但還在 beta、每日上限沒公開；Resend 免費方案每天只能寄 100 封。
2. **D1／DO**：D1 單一資料庫一次只跑一個 query，`UPDATE ... SET n=n-1 WHERE n>0` 再檢查 `changes` 就能原子扣額度；這個專案的規模用 D1 就夠，DO 留給更高的寫入量或有狀態的流程。
3. **Workers**：等待 Anthropic 回應是 wall time，不算 CPU time，HTTP 請求的 wall time 也沒有上限；但 Free 方案每請求只有 10 ms CPU、每天 10 萬次請求，實際上要用 $5/月的 Paid。Rate Limiting binding 是分地點計算的近似值，只能擋濫用，不能算額度。
4. **Paddle**：checkout 要放在通過審核的 HTTPS 網站上（要有 Terms、Refund、Privacy 和價格頁）。user_id 放進 `custom_data` 後會複製到 subscription，可以在 webhook 拿回來。簽章是 `HMAC-SHA256(ts:rawBody)`，在 Worker 用 Web Crypto 就能驗。取消預設到期才生效。
5. **登入**：side panel 內的 OTP 最直接；magic link 會打開一般分頁，需要 `externally_connectable` 或輪詢才能把 token 交回外掛。`launchWebAuthFlow` 只攔截它自己視窗裡的 chromiumapp.org 導向，接不到從郵件點開的連結。
