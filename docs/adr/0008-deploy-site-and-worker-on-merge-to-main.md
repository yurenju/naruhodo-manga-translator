# 網站與 Worker 合併到 main 就自動部署，live 的 key 只放在 Cloudflare

上線 production（#97）時要決定三件事：網站（`site/`）和 Worker（`worker/`）怎麼部署、什麼時候部署，以及 live 的 key 放在哪裡。外掛的發版已經有手動觸發的 `release.yml`（先跑型別檢查與單元測試），Web Store 審核也要時間，所以外掛維持原樣。

## 決定

- **網站與 Worker 在合併到 main、CI 通過後自動部署。** 部署 job 放在 `.github/workflows/ci.yml`，`needs: [check, browser]`，只在 push 到 main 時跑。網站用 Workers 的靜態資源（`site/wrangler.jsonc`），Worker 用 `worker/wrangler.jsonc`；兩個都用 `routes` 的 `custom_domain` 綁網域（`naruhodo.page`、`api.naruhodo.page`），網域設定在 repo 裡，不在後台。
- **用 GitHub Actions 部署，不用 Cloudflare 的 Git 整合（Workers Builds）。** Workers Builds 收到 push 就部署，不會等 GitHub 的 CI 通過；部署設定也只在 Cloudflare 後台。
- **Worker 的部署順序是 migrations → deploy → 健康檢查（`GET /v1/health`，會查一次 D1）。** 健康檢查失敗就 `wrangler rollback` 退回上一版程式碼。`concurrency` 讓連續合併的部署排隊，不中斷跑到一半的 migration。
- **live 的 key 只放在 Cloudflare 的 Worker secrets。** `CLAUDE_API_KEY`、`RESEND_API_KEY`、`PADDLE_API_KEY`、`PADDLE_PRICE_ID`、`PADDLE_WEBHOOK_SECRET` 本機與 GitHub 都不留。（原本由 `scripts/production-wizard.sh` 直接 pipe 給 `wrangler secret put`；ADR 0011 起本機沒有寫入權，改成在 Cloudflare 後台設定。）GitHub 只放一個權限受限的 `CLOUDFLARE_API_TOKEN`（只能部署這兩個 Worker 與 D1）；Paddle 的 client-side token 會出現在網頁原始碼，放 GitHub variables。
- **部署 job 要 `vars.DEPLOY_ENABLED == 'true'` 才跑。** 由 wizard 最後一步打開：D1、secrets、網域都設好之前，合併不會部署出一個不能用的 Worker。

## 不直覺的地方

- **自動部署讓「新的資料表配舊的程式碼」成為常態。** migration 比新程式碼早幾秒上線，`wrangler rollback` 也只退程式碼、不退資料表結構。所以 migration 只能加不能改，改名或刪欄位拆成兩次部署（`CODING_STANDARDS.md`）。
- **Worker 上線時一定還有舊版外掛在打它。** 外掛手動發版、Web Store 要審核、使用者更新有快有慢，Worker 卻是合併就上線。API 只加不改（`CODING_STANDARDS.md`）。
- **`wrangler deploy` 不檢查 secret 在不在。** PR 讓 Worker 多讀一個 secret 時，要先在 Cloudflare 後台設定再合併。vars 與 bindings 不會從 `wrangler.jsonc` 的最上層繼承，`scripts/wrangler-config.test.ts` 檢查 env.dev 有的 production 也有。
- **CI 測不到真的 Paddle 與 Anthropic。** browser test 用 `env.test` 的假實作，健康檢查也只查 Worker 與 D1。接上外部服務的錯誤要等上線後才看得到；`npm run smoke`、`npm run smoke:paddle` 仍要在改到那些呼叫時手動跑。
- **CORS 放行所有 `chrome-extension://` origin。** 正式版外掛沒有 `host_permissions`（加了的話，更新時 Chrome 會先停用外掛等使用者同意），呼叫 Worker 是跨網域請求。GitHub Release 的 zip 解壓縮安裝時外掛 id 依路徑而定，沒辦法列出允許的 id；身分靠 Bearer token，CORS 不是安全界線。

## 不採用的做法

- **Worker 手動觸發部署、網站自動部署。** 比較保守，但這是個人專案、還沒宣傳，上線後再調整的成本低；用上面的規則與健康檢查把風險壓下來。
- **Cloudflare Pages 放網站。** Cloudflare 新專案主推 Workers 的靜態資源，網站和 API 用同一套工具，token 權限也少一項。
- **live 的 key 存在本機的設定檔（像 sandbox 的 `~/.config/naruhodo/paddle-sandbox.env`）。** Worker 只從 Cloudflare 讀，本機那份沒有用處，只多一個外洩的地方。key 弄丟就到後台建一把新的再 `put`，順便撤銷舊的。
