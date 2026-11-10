# 訂閱定價的成本與用量事實

擷取日期：2026-11-10。這份只整理事實和試算，不做定價結論。競品名稱、價格和個別帳號的資料不放 repo，放在本機的 `%LOCALAPPDATA%\naruhodo\research\pricing.md`。

## 1. 一頁翻譯會用到哪些付費服務

| 服務 | 有沒有每頁成本 | 出處 |
|---|---|---|
| 文字偵測與 OCR | 沒有。在外掛的 offscreen document 裡用 onnxruntime-web 跑 comic-text-and-bubble-detector 和 manga-ocr，完全在使用者的電腦上執行 | `src/offscreen/ort-engine.ts:1-10` |
| Claude API | 有。Worker 只把文字送給 Anthropic，不送圖片 | `worker/src/index.ts:3` |
| Cloudflare Workers + D1 | 每月固定費用，每頁的邊際成本可以忽略（見 §2.2） | `worker/wrangler.jsonc` |

每個 Page 會呼叫 Claude 兩次（ADR 0005，`src/shared/claude-request.ts:6-9`）：
1. `translateRequest`：產生譯文。
2. `notesRequest`：更新 Series Notes。

兩次的 system 都標了 `cache_control`。另外大約每一話會呼叫一次 `seriesGuessRequest`（猜作品原名），這次不扣頁。

模型是 `CLAUDE_MODEL = 'claude-haiku-5-5'`（`src/shared/claude-request.ts:27`）。Worker 會照價目表算出每次呼叫的 `cost_usd` 並寫進 D1 的 `usage_records`（`src/shared/claude-request.ts:44-79`、`worker/src/quota.ts:91-123`）。

## 2. 單價

### 2.1 Claude Haiku 5.5

來源：https://platform.claude.com/docs/en/about-claude/pricing

| 項目 | $/MTok |
|---|---|
| Input | 0.10 |
| 5 分鐘 cache write | 0.125 |
| Cache read | 0.01 |
| Output | 0.50 |

- prompt 超過 100k tokens 時，整個請求改用 0.50 / 2.50 的價格。我們的每次請求大約 6–10k tokens，碰不到這條線。
- 程式碼裡的價目表（`src/shared/claude-request.ts:47-51`）和官方頁一致。
- Batch API 打五折，但我們是即時翻譯，不適用。

其他模型的單價供比較用（同一來源）：

| 模型 | Input / Output（$/MTok） | 相對 Haiku 5.5 |
|---|---|---|
| Sonnet 5.5 | 2 / 10 | 約 20 倍 |
| Opus 5.5 | 4 / 20 | 約 40 倍 |

### 2.2 Cloudflare

來源：https://developers.cloudflare.com/workers/platform/pricing/ 、 https://developers.cloudflare.com/d1/platform/pricing/

- **Workers Paid**：每月 $5，含 10M requests 和 30M CPU ms。
- **D1（Workers Paid 方案）**：每月含 25B rows read、50M rows written、5 GB 儲存。

一頁大約只有幾個 request、十幾筆 row 的讀寫，離這些上限還很遠。所以 Cloudflare 可以當成每月 $5 的固定成本來算。這台機器只有唯讀權限，看不到帳號實際訂的是哪個方案，未驗證。

## 3. Production 實測：每頁成本與 token

資料範圍是 production D1 的 `usage_records`，期間為 2026-10-31 到 2026-11-10，共 1,338 個扣頁的翻譯（不含試翻），其中 1,335 個有 Notes 呼叫。

**每頁成本**（translate 加上同一頁的 notes）：

| 平均 | P50 | P90 | P99 | 最大 |
|---|---|---|---|---|
| $0.00052 | $0.00047 | $0.00096 | $0.0014 | $0.0024 |

**每頁 token**：input 這一欄是 input、cache read、cache write 三者的合計。

| 呼叫 | input 平均（P90） | output 平均（P90） |
|---|---|---|
| translate | 7,125（8,972） | 275（511） |
| notes | 5,631（7,100） | 388（948） |

- 兩種呼叫的 input 大約有 70–80% 是 cache read。translate 平均 3,850 tokens 沒快取，3,014 tokens 是 cache read。
- `series_guess` 每次約 $0.00013，大約每話一次，可以忽略。
- 新帳號的 50 頁 Free Pages（`src/shared/hosted-api.ts:74`）照平均算大約 $0.026。

**用量**：

- 這段期間 production 有 4 個帳號，其中 2 個是訂閱中。
- 用最多的帳號 11 天翻了 1,203 頁，單日最多 425 頁、330 頁。照這個速度一個月約 3,300 頁。
- 其他帳號在這段期間分別是 64、50、21 頁。
- 樣本很小，幾乎就是開發者自己和少數朋友，算不出有代表性的中位數或 P90。

## 4. 現行方案在程式碼裡的位置

| 項目 | 值 | 出處 |
|---|---|---|
| 年費 | US$20（文案寫平均每月 US$1.67） | `src/shared/hosted-api.ts:80`、`:88` |
| 每月頁數（文案用） | 800 | `src/shared/hosted-api.ts:81` |
| 每月頁數（真正的上限） | `MONTHLY_PAGE_LIMIT: "800"` | `worker/wrangler.jsonc:39`（dev `:51`、test `:70`） |
| Free Pages | 50（每個 email 只給一次） | `src/shared/hosted-api.ts:74`、`worker/src/quota.ts:20-23` |
| Paddle 價格 | `PADDLE_PRICE_ID` 是 Cloudflare 上的 secret，換價格不用改程式碼 | `worker/wrangler.jsonc:15-17` |

**額度怎麼算**：

- 每月的週期從訂閱開始日起算，每個月同一天重置（`worker/src/quota.ts:31-33`、`subscription.ts` 的 `monthlyCycle`）。
- 長 Page 的接續翻譯，在 1 小時內最多 10 次不另外扣頁（`worker/src/quota.ts:66-76`）。

**超過額度時**：

- Worker 回 402 `monthlyLimitReached`（`worker/src/index.ts:118-119`、`:149`）。免費額度用完則是 `freePagesExhausted`。
- 外掛不把這當成失敗。頁面照樣顯示原文和讀音，只是沒有譯文。side panel 頂端和 Page 右上角會出現「本月額度用完了・查看方案」（`src/background/page-translation.ts:166-168`、`src/shared/page-status.test.ts:74`）。
- 沒有加購頁數的機制，只能等下個週期重置。

## 5. Paddle 手續費

來源：https://www.paddle.com/pricing

- 每筆交易 5% + $0.50。
- 定價頁寫明低於 $10 的商品應聯絡 Paddle 談客製費率。

**其他費用**（https://www.paddle.com/help/manage/risk-prevention/understanding-chargebacks-with-paddle 、 https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts ）：

- Chargeback 每筆 $20，Paddle 贏了也不退。這和定價頁「費率已含 chargebacks」的說法不一致，要以合約為準。
- 電匯幣別和收款銀行所在國的本地幣別不同時，每次收 $15。
- 換匯最多另加 1.5%。

**實際費率**：照 (0.05P + 0.5) / P 自行計算。手續費是以含稅價還是未稅價計算，官方沒寫，未驗證。

| 價格 | $2.99/月 | $4.99/月 | $9.99/月 | $14.99/月 | $20/年 | $36/年 | $60/年 |
|---|---|---|---|---|---|---|---|
| 費率 | 21.7% | 15.0% | 10.0% | 8.3% | 7.5% | 6.4% | 5.8% |

月繳時那 $0.50 每個月都要付一次，年繳一年只付一次。

## 6. 試算：用滿額度的訂閱者每月毛利

計算方式：

- 毛利 =（價格 − Paddle 手續費）÷ 月數 − 額度 × 每頁成本。
- 每頁成本分兩種情境：平均 $0.00052，以及保守的 P90 $0.00096。
- 毛利率的分母是標價（換算成每月）。
- 沒有扣 Cloudflare 每月 $5 的固定成本、稅、chargeback 和退款。

| 方案 | 每月淨收入 | 額度 | API 成本（平均／P90） | 毛利（平均） | 毛利率（平均） | 毛利（P90） | 毛利率（P90） |
|---|---|---|---|---|---|---|---|
| 年繳 $20（現行） | $1.54 | 800 | $0.42 / $0.77 | $1.13 | 68% | $0.77 | 46% |
| 年繳 $20（現行） | $1.54 | 2000 | $1.04 / $1.92 | $0.50 | 30% | −$0.38 | −23% |
| 年繳 $20（現行） | $1.54 | 5000 | $2.60 / $4.80 | −$1.06 | −63% | −$3.26 | −195% |
| 年繳 $36 | $2.81 | 800 | $0.42 / $0.77 | $2.39 | 80% | $2.04 | 68% |
| 年繳 $36 | $2.81 | 2000 | $1.04 / $1.92 | $1.77 | 59% | $0.89 | 30% |
| 年繳 $36 | $2.81 | 5000 | $2.60 / $4.80 | $0.21 | 7% | −$1.99 | −66% |
| 年繳 $60 | $4.71 | 800 | $0.42 / $0.77 | $4.29 | 86% | $3.94 | 79% |
| 年繳 $60 | $4.71 | 2000 | $1.04 / $1.92 | $3.67 | 73% | $2.79 | 56% |
| 年繳 $60 | $4.71 | 5000 | $2.60 / $4.80 | $2.11 | 42% | −$0.09 | −2% |
| 月繳 $2.99 | $2.34 | 800 | $0.42 / $0.77 | $1.92 | 64% | $1.57 | 53% |
| 月繳 $2.99 | $2.34 | 2000 | $1.04 / $1.92 | $1.30 | 43% | $0.42 | 14% |
| 月繳 $2.99 | $2.34 | 5000 | $2.60 / $4.80 | −$0.26 | −9% | −$2.46 | −82% |
| 月繳 $4.99 | $4.24 | 800 | $0.42 / $0.77 | $3.82 | 77% | $3.47 | 70% |
| 月繳 $4.99 | $4.24 | 2000 | $1.04 / $1.92 | $3.20 | 64% | $2.32 | 47% |
| 月繳 $4.99 | $4.24 | 5000 | $2.60 / $4.80 | $1.64 | 33% | −$0.56 | −11% |
| 月繳 $9.99 | $8.99 | 800 | $0.42 / $0.77 | $8.57 | 86% | $8.22 | 82% |
| 月繳 $9.99 | $8.99 | 2000 | $1.04 / $1.92 | $7.95 | 80% | $7.07 | 71% |
| 月繳 $9.99 | $8.99 | 5000 | $2.60 / $4.80 | $6.39 | 64% | $4.19 | 42% |

讀這張表要注意：

- **P90 是很保守的假設**。整個月每一頁都用 P90 成本的情況不太會發生，實際的月平均應該接近「平均」那一欄。
- **固定成本要另外分攤**。Cloudflare 每月 $5 由所有訂閱者分攤。訂閱者少的時候，這筆比 API 成本還大。
- **換模型會改變整張表**。如果改用 Sonnet 5.5，每頁成本大約是 20 倍。

## 待確認

- Paddle 的手續費是以含稅價還是未稅價計算，以及低於 $10 的客製費率是多少。
- Cloudflare 帳號實際訂的方案（Free 或 Paid）。
- 等有更多訂閱者後，重新查一次每個帳號每月頁數的分布。查詢方式見 `docs/agents/prod-access.md`。
