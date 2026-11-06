# 本機對 Cloudflare 只有唯讀，查 production 經過本機 proxy

網站、Worker 和 migrations 都由 CI 部署（ADR 0008），本機不需要寫入權。但本機原本用 `wrangler login`：OAuth 的 scopes 涵蓋整個帳號的寫入權（Workers、D1、secrets…），這台電腦上的任何 agent session 都能 `wrangler deploy` 或對 production D1 下 `DELETE`。所以本機改成只有唯讀：查 production 的 D1 和 Worker log 用一把唯讀的 Account API token，寫入只走 CI 或 Cloudflare 後台手動操作。

## 決定

- **本機不留 `wrangler login`。** 唯讀 token 只放在 1Password，`~/.config/naruhodo/cloudflare-readonly.env` 只放 `op://` 參照與 Account ID。這份檔案跟 `op.env` 分開，`worker:dev`、`smoke` 不會拿到 Cloudflare token。
- **查詢經過本機 proxy。** `npm run prod:connect` 用 `op run` 取一次 token，起一個只聽 127.0.0.1 的 proxy，閒置 30 分鐘自動結束。`prod:sql`、`prod:logs` 打這個 proxy，不打 Cloudflare。
- **proxy 只轉發白名單。** 只轉發三種請求：naruhodo 這個 D1 的查詢（SQL 只接受 `SELECT`／`WITH`／`PRAGMA`／`EXPLAIN` 開頭）、`naruhodo-api` 的歷史 log 查詢、`naruhodo-api` 的 tail。其他一律拒絕。
- **Worker secrets 在 Cloudflare 後台手動改。** `production-wizard.sh` 不再建 D1、部署或 `wrangler secret put`（取代 ADR 0008 裡「由 wizard pipe 給 `wrangler secret put`」那段）。

## 不直覺的地方

- **proxy 存在是為了減少 1Password 授權次數。** 1Password CLI 每個終端機 session 授權一次，agent 每次執行指令都是新的行程。如果每個查詢各自 `op run`，一次除錯會跳十幾次授權。改成 proxy 後，一次除錯只授權一次，token 也只存在 proxy 行程的記憶體裡。
- **白名單補上 token 做不到的範圍限制。** D1 Read 對整個帳號有效，不能限定單一資料庫，同一帳號下其他專案的資料庫也讀得到。所以「只碰 naruhodo 的資源」靠 proxy 的白名單來做。SQL 開頭檢查是第二道防線，token 本身就不能寫。
- **查歷史 log 的 API 文件只列了 Workers Observability Write 權限。** 如果 Read 權限查不了，token 就帶 Observability Write：它只能改 log 設定，碰不到程式碼、資料與 secrets，proxy 也只轉發查詢。

## 不採用的做法

- **每個查詢各自 `op run`，靠文件要求 agent 把查詢集中成一支 script。** 第一次查做得到，但除錯是一來一回的，每追問一次就再跳一次授權。
- **保留 `wrangler login`，只要求 agent 不要寫入。** 同一台電腦、同一個使用者帳號，agent 拿得到的權限跟人一樣，規則擋不住。
- **用 GitHub Actions 的 `workflow_dispatch` 換 secret。** live 的 secret 要多經過 GitHub，換 secret 一年也沒幾次，後台手動改比較單純。
