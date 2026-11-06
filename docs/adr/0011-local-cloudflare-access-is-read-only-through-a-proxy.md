# 本機對 Cloudflare 只有唯讀，查 production 經過本機 proxy

網站、Worker 和 migrations 都由 CI 部署（ADR 0008），本機不需要寫入權。但本機原本用 `wrangler login`：OAuth 的 scopes 涵蓋整個帳號的寫入權（Workers、D1、secrets…），這台電腦上的任何 agent session 都能 `wrangler deploy` 或對 production D1 下 `DELETE`。所以本機改成只有唯讀：查 production 的 D1 和 Worker log 用一把唯讀的 Account API token，寫入只走 CI 或 Cloudflare 後台手動操作。

## 決定

- **本機不留 `wrangler login`。** 唯讀 token 只放在 1Password，`~/.config/naruhodo/cloudflare-readonly.env` 只放 `op://` 參照與 Account ID。這份檔案跟 `op.env` 分開，`worker:dev`、`smoke` 不會拿到 Cloudflare token。
- **查詢經過本機 proxy。** `npm run prod:connect` 用 `op run` 取一次 token，起一個只聽 127.0.0.1 的 proxy，閒置 30 分鐘自動結束。`prod:sql`、`prod:logs`、`prod:tail` 打這個 proxy，不打 Cloudflare。
- **Worker 開 Workers Logs（`observability`）。** 原本只有 `wrangler tail` 看即時的，bug 過去了就查不到；開了之後 `prod:logs` 查得到 7 天內的 log。
- **proxy 只轉發白名單。** 只轉發三種請求：naruhodo 這個 D1 的查詢（SQL 只接受 `SELECT`／`WITH`／`PRAGMA`／`EXPLAIN` 開頭）、`naruhodo-api` 的歷史 log 查詢、`naruhodo-api` 的 tail。其他一律拒絕。
- **Worker secrets 在 Cloudflare 後台手動改。** `production-wizard.sh` 不再建 D1、部署或 `wrangler secret put`（取代 ADR 0008 裡「由 wizard pipe 給 `wrangler secret put`」那段）：key 驗證後經剪貼簿交給你貼到後台，D1 也在後台建。
- **第一次部署也交給 CI，Worker 會先在沒有 secrets 的狀態上線。** 後台只能替已經存在的 Worker 設 secrets，本機又不能部署，所以 `production-wizard.sh` 在第 5 步就打開 `DEPLOY_ENABLED`（取代 ADR 0008 裡「wizard 最後一步才打開」那段）。健康檢查只查 D1，會通過；翻譯、寄信、付款在 secrets 設好之前都會失敗，產品還沒上線前這段空窗可以接受。
- **`wrangler logout` 是整台電腦的事。** 其他專案如果也靠 `wrangler login`，登出後要各自建一把只碰自己資源的 token，照 `docs/agents/prod-access.md` 的做法。

## 不直覺的地方

- **proxy 存在是為了減少 1Password 授權次數。** 1Password CLI 每個終端機 session 授權一次，agent 每次執行指令都是新的行程。如果每個查詢各自 `op run`，一次除錯會跳十幾次授權。改成 proxy 後，一次除錯只授權一次，token 也只存在 proxy 行程的記憶體裡。
- **白名單補上 token 做不到的範圍限制。** D1 Read 對整個帳號有效，不能限定單一資料庫，同一帳號下其他專案的資料庫也讀得到。所以「只碰 naruhodo 的資源」靠 proxy 的白名單來做。SQL 開頭檢查是第二道防線，token 本身就不能寫。
- **token 只有兩個權限：D1 Read 與 Workers Metadata Read-Only。** 查歷史 log 的 API 文件只列了 Workers Observability Write，原本打算 Read 查不了就接受 Write；實際建立時 Cloudflare 已經改成新的角色模型，Workers Metadata Read-Only 就能查歷史 log 與 tail，不需要任何 Write。標著 Legacy 的 Workers Tail、Workers Observability 都不用另外勾。

## 不採用的做法

- **每個查詢各自 `op run`，靠文件要求 agent 把查詢集中成一支 script。** 第一次查做得到，但除錯是一來一回的，每追問一次就再跳一次授權。
- **保留 `wrangler login`，只要求 agent 不要寫入。** 同一台電腦、同一個使用者帳號，agent 拿得到的權限跟人一樣，規則擋不住。
- **用 GitHub Actions 的 `workflow_dispatch` 換 secret。** live 的 secret 要多經過 GitHub，換 secret 一年也沒幾次，後台手動改比較單純。
