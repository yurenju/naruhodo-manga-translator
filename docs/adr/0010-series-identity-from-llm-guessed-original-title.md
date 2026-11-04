# Series 的身分用 LLM 從頁面標題猜出的原名來判斷

不開側邊欄的讀者（[#185](https://github.com/yurenju/naruhodo-manga-translator/issues/185)）從來不會選 Series，每一話都變成一個新的 Provisional Series，前一話累積的 Series Notes 下一話用不到（[#186](https://github.com/yurenju/naruhodo-manga-translator/issues/186)）。URL Pattern 救不了：Canvas Site 和 E-book Reader 每一話（每一集）的網址都只有一串 ID，**路徑裡沒有作品 ID**，「路徑前綴相同就是同一部」行不通，URL Pattern 只會在重看同一話時命中。

作品名一定出現在 `document.title` 或 `og:title` 裡，只是格式依網站差很多：Canvas Site 是「[話數]作品名 - 作者 | 網站名」；E-book Reader 的 `document.title` 只有閱讀器的名稱，`og:title` 是「作品名 THE COMIC 1 (レーベル)」或「作品名1巻 (レーベル)」。

## 決定

- **啟動時讀頁面文字，交給 Haiku 抽出原名**（Original Title）：`document.title`、`og:title`、前 3 個 `h1`～`h3`。回傳 `{status: work|unknown, 原名, 中文譯名}`。不寫網站專屬的解析規則，也不做網站 adapter（通用優先於網站專屬）。
- **不送網址和 hostname**，維持「不會送出網址」的承諾。**也不送讀者已有的作品清單**（見下方實驗）。
- **程式端比對**：原名正規化（NFKC、合併空白）之後完全相同就是同一部作品；不同網站讀同一部作品也歸到同一個 Series。
- **優先順序**：URL Pattern 命中 → 原名命中既有 Series（Provisional 也算）→ 猜到原名就新建 Provisional Series，名稱用原名 → 猜不出來就建未命名的 Provisional Series。有把握就直接套用，不另外詢問讀者；side panel 的作品卡讓讀者確認或改。
- **和 OCR 並行**：一啟動就開始擷取與 OCR，翻譯呼叫等 Series 決定之後才送，決定後先查那部 Series 的快取。Haiku 失敗或逾時（5 秒）就當作猜不出來。
- **同一個分頁換網址**：URL Pattern 命中就換；對不上就在載入完成後重讀頁面文字，**跟上次完全一樣就不呼叫**（避免 SPA 沒更新的舊 metadata，也省一次呼叫）；不一樣才重猜，猜到另一部就切換，猜不出來就沿用目前的。
- **Hosted Translation 和 Own API Key 都做**，prompt 與 schema 在共用的 `shared/claude-request.ts`。Hosted 是 Worker 的 `POST /v1/series-guess`：限制輸入長度、依 Account 限制頻率、**不算 Translated Page**，也不寫用量紀錄。
- 「首頁、列表、搜尋、登入頁、雜誌合集」回 unknown。
- **讀者的修正只改之後的頁**：歸錯時，已經寫進去的快取和 Notes 條目不搬走（LLM 只能新增條目，傷害有限）。讀者改選別部或合併時，把這次猜到的原名記到目標上（一部 Series 可以有多個原名），下次直接歸到那裡。
- 送給翻譯 LLM 的作品名改用原名；中文譯名只是顯示用的副標，建立時猜一次、之後不更新。

## 實驗（Haiku，36 個頁面：Canvas Site 18 話、E-book Reader 18 本，包含外傳、續作、登入頁）

| 做法 | 原名錯誤 | 錯誤種類 |
|---|---|---|
| 只靠抽取（兩輪） | 1 / 68 | 續作第 2 集多留了一個集數 → **多拆**一部 |
| 只靠抽取、不送 hostname | 0 / 36 | — |
| 另外送「這個網站已知的原名」 | 2 / 34 | **外傳被併進本傳**（誤合併）；一部作品被判成 unknown |

送已知清單反而會造成誤合併，而且讀者看不到，所以不採用。只靠抽取的錯誤是「多拆」，最壞的情況就是 #186 以前的行為（每一話一部）。中文譯名很不穩定（同一部作品四輪出現四種譯名），所以只當副標、不拿來比對。

**成本**：平均 932 input／51 output tokens，約 $0.00012／次，延遲約 1.3 秒。翻譯一頁（翻譯＋Notes）約 $0.0007，猜一次大約是一頁的 1/6；大約每一話呼叫一次，一話 20～50 頁的話，成本增加約 0.4%～0.9%。

## 不採用

- **網址規則**（路徑前綴、同一個 origin 上次用的 Series）：兩種網站的網址沒有作品 ID。
- **網站 adapter**（每個網站寫一套標題解析）：違反通用優先於網站專屬，每個新網站都要寫。
- **送已知清單讓 LLM 挑**：誤合併，見上方實驗。
- **Provisional Series 的自動清理**：多拆的那幾部由讀者合併，不另外做。
