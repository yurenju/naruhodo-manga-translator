# Hosted Translation 經過一個不保存內容的 Cloudflare Worker，OCR 仍在本機

要上架收費，又要保持開源，所以預設的翻譯方式改成 Hosted Translation：外掛不再帶使用者的 key 直接打 Anthropic，而是把文字送到我們的 Cloudflare Worker，由 Worker 檢查 Account 的額度、用公司的 key 呼叫 Anthropic、記帳。Own API Key 保留成選用、比較不顯眼的路徑，兩者由使用者明確二選一，不會自動互相退回。Worker 與網站跟外掛放在同一個 repo，一起開源：別人照樣能自己架一份，但要自己付 Anthropic 的錢。

## 決定

- **Worker 只收文字，偵測與 OCR 留在本機**（[ADR 0001](0001-translation-pipeline-placement.md) 不變）。OCR 只占每頁延遲的 20–30%（#7：M1 WebGPU 約 1.7 s，LLM 約 3.5 s），而且搬到後端要養 GPU（每月固定約 $250–450，或忍受 serverless 冷啟動），出版社的圖也會經過我們的伺服器。留在本機，Worker 就是用多少付多少的薄 proxy。
- **Worker 不保存任何漫畫內容。** 只存 Account、Subscription、每個 Translated Page 一筆用量（時間、tokens、成本）。Series Notes 與 Prior Pages 照舊只在本機，每次請求由外掛帶上來。
- **prompt 在 Worker 組。** 外掛只送結構化的輸入（這一頁的 Lines、Prior Pages、Series Notes）；model、`max_tokens`、system prompt、JSON schema 由 Worker 決定。組 request body 的程式碼是外掛與 Worker 共用的同一個模組，Own API Key 路徑也用它。
- **額度用 Translated Page 算**，由 Worker 在 Anthropic 成功回傳翻譯之後才扣，用 D1 的條件式 `UPDATE ... WHERE 剩餘 > 0` 原子地扣，不靠 Rate Limiting binding（它是各地點分開的近似值，見 `docs/research/track-b-backend-facts.md`）。

## 不直覺的地方

- **程式碼公開，所以 Worker 不能是轉發器。** 誰都看得到請求格式；如果 Worker 照收 client 給的 model 與 prompt，訂閱帳號就能拿來跑任意的 Claude 工作。所以 client 端改不了要問什麼，只能給這一頁的文字。
- **額度用完不是整個停擺。** 本機的偵測、OCR、kuromoji 讀音照跑（同 ADR 0001 沒有 key 時的退路），只是沒有譯文。
- **Worker 打包了 Practice Spread 的原文**（#169，`practice-spread/ocr.json`），用來認出試翻頁、不扣頁。這是我們自己的原創內容、寫死在程式碼裡的靜態資料，不是讀者送來後存下的東西，不違反「Worker 不保存任何漫畫內容」。
- **用量紀錄是刻意留的。** 它不只拿來算每月上限，也是量真實每頁成本的唯一來源：上線前的成本數字是合成測試頁量的（ADR 0005），價格與 Monthly Page Limit 之後要照它調。

## 不採用的做法

- **OCR 在後端，跟翻譯同一個請求做完。** 能少一趟來回、首次不用下載 128–472 MB 模型、弱電腦也一樣快；但每頁省不到 1 秒，換來 GPU 的固定成本與圖片隱私問題。等沒有 WebGPU 的付費使用者夠多，可以只讓他們走後端 OCR，不必全部搬。
- **Worker 也存 Series Notes，讓換電腦能同步。** 跟付費無關，而且會讓 Worker 開始保存漫畫相關的內容。要做也是另一個功能。
- **Durable Objects 當每個 Account 的計數器。** 天生不會 race，但跨 Account 的統計（每月總頁數、成本）很麻煩；D1 的條件式更新就夠了。
- **商店版只有訂閱，Own API Key 只留在開源版。** 會讓「開源卻鎖功能」的觀感更重，而且 Own API Key 是現成的功能。
