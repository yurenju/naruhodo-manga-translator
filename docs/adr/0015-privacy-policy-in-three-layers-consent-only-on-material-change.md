# 隱私政策分三層，只有 Material Change 才重新同意

上線三週，Hosted Translation 的 Data Use Consent（`DATA_CONSENT_VERSION`）已經升到第 5 版。PRIVACY.md 把用量紀錄的欄位一個一個列出來，結尾又寫「資料處理方式改了就重新請你同意」，所以每加一個量測欄位都要讓所有讀者再按一次同意。開發初期觀察欄位會常常加（#341 的成本調查就要六個），每次都問會讓讀者疲乏，也讓維護者不敢加量測。所以政策改成「原則上保護隱私、細節寫成類別」，只有 Material Change 才升版。

## 決定

政策分三層：

| 層 | 寫什麼 | 改了要重新同意嗎 |
|---|---|---|
| ① 承諾 | 我們不做的事 | 要 |
| ② 法律要求具體寫的事 | 第三方是誰、保存多久、讀者的權利 | 看情況（多一個第三方、保存更久就要） |
| ③ 現況細節 | 目前實際記了哪些欄位、存了哪些設定 | 不用，記在 PRIVACY.md 的 git 歷史 |

① 的四條承諾（PRIVACY.md「Our commitments」）：

1. 漫畫的文字、譯文、Series Notes 只送去翻譯，服務不保存。
2. **We don't keep what you read**：

   > The Naruhodo service does not store the manga's text, translations, Series Notes, images, series names, page titles or page addresses. It may keep measurements about your requests and how you use the extension, and random identifiers the extension generates, which by themselves do not say which manga or page they are about.

3. 外掛不會送出圖片與網址。
4. 不做廣告、不賣資料、外掛裡沒有第三方的分析或追蹤程式。

③ 寫成類別：用量紀錄是「關於請求本身的量測與分類（數量、大小、時間、結果），以及外掛產生的隨機作品 ID」，用「such as」舉例，實際欄位以 `worker/migrations/` 為準；本機的設定清單是「設定與使用進度」一個類別。用途一次寫廣：提供、保護、計費與改善這個服務（Limited Use 段落用同一句）。

**Material Change**（GLOSSARY）才升 `DATA_CONSENT_VERSION`，五個條件：

- ① 的承諾要放寬
- 新種類的內容離開讀者的電腦（圖片、網址、標題，或其他看得出讀了什麼的東西）。關於請求本身的數字或旗標（條目數、是不是 Retranslation）不算，即使要外掛多送上來
- 多一個第三方
- 用途超出上面那句
- 保存更久

加界線內的欄位、加設定、改寫文字只改政策文字（git 歷史就是變更紀錄），不升版。

這次（#341）擴大用途、開始存作品 ID，算 Material Change：Hosted Translation 5 → 6。Own API Key 沒有用量紀錄，政策改成類別寫法對它不算，維持 5。

## 不直覺的地方

- **界線刻意比「我們沒辦法知道你讀了什麼」寬鬆。** 外掛產生的隨機作品 ID（`Series.id`，UUID）可以存，以後能按作品看成本隨閱讀深度的變化；作品名、頁面標題、網址不行。單看 ID 說不出是哪部作品，但一串紀錄看得出「某人某段時間連讀同一部多少頁」，所以刪除帳號時匿名保留的用量紀錄會把 `series_id` 設成 NULL，維持「only the numbers stay」。Worker 也只收長得像 UUID 的作品 ID，client 送作品名過來不會存。
- **第 4 條只擋第三方的追蹤。** 原本政策寫「外掛裡沒有分析或追蹤程式」，會連外掛端自己的使用量測（新手卡在哪一步、功能有沒有人用、本機的錯誤）都擋住，這些只有外掛看得到、Worker 量不到。趁這次本來就要升版一起放寬：自己的量測受第 2 條同一條界線約束（不含內容、作品名、標題、網址），政策只寫成「how you use the extension」這個類別，不列量哪些東西。第三方的分析程式照樣不行。
- **Worker 不知道讀者同意的是第幾版。** 同意記在外掛本機，而 Chrome 更新外掛要幾小時到幾天，這段期間舊版外掛還在呼叫新版 Worker（ADR 0008）。外掛其實早就把作品 ID 送到 Worker（每個 Notes 條目都帶 `seriesId`），如果 Worker 從那裡拿來存，只同意過舊版的讀者也會被存下作品 ID。所以**新存的資料只從新版外掛才會送的欄位拿**：作品 ID 只取請求最上層的 `seriesId`，沒送就存 NULL；`notesEntries`、`retranslation` 同理。這樣 Worker 先部署也沒關係。
- **Worker 自己數得出的數字不需要新版外掛。** 送了幾條 Notes 條目、翻了幾句、補問了幾句 Suspect Line 是 Worker 處理請求時本來就看得到的請求本身的量測，舊版外掛的請求也照記。

## 不採用的做法

- **每加一個欄位都升版（原本的做法）。** 讀者三週內按了五次同意；每次升版還要在補同意卡寫一行變更摘要，量測越加越不敢加。
- **政策完全只寫類別，連第三方都不具名。** 法律（GDPR 的告知義務、Chrome Web Store 的 User Data Policy）要求具體寫出第三方、保存期限與讀者的權利，所以這些留在 ② 具體寫。

## 後果

- 改到 `worker/migrations/`、或外掛送出的資料時，要對照 Material Change 的五個條件（`docs/agents/privacy-changes.md`，CODING_STANDARDS.md 的 review 規則）。不是 Material Change 也要確認 PRIVACY.md 與同意卡（`src/ui/data-flow.tsx`）的類別文字涵蓋新的欄位。
- 用量紀錄的保存期限目前等於永久，還沒處理；要縮短時不算 Material Change，要延長時算。
