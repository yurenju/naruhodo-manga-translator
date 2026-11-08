# Chrome Web Store 上架資料

送審時照這份複製貼上到 Developer Dashboard。規則與出處見 [docs/research/chrome-web-store-listing.md](../research/chrome-web-store-listing.md)。

改了資料處理方式（送出的內容、連線對象、儲存的東西）時，這份、[PRIVACY.md](../../PRIVACY.md)、外掛的同意文字（`src/ui/data-flow.tsx`）與 Dashboard 的 Privacy practices 要一起改。

## Store listing 分頁

| 欄位 | 內容 |
|---|---|
| 名稱 | `Naruhodo 日文漫畫翻譯`（從 manifest 的 `name` 讀）。名稱帶上用途，在搜尋結果裡跟另一個同名的外掛分得開；工具列等空間小的地方顯示 `short_name` 的 `Naruhodo` |
| 摘要 | 從 manifest 的 `description` 讀（`src/manifest.ts`，最多 132 字） |
| 類別 | Tools |
| 語言 | Chinese (Taiwan)。manifest 沒有 `_locales`，所以只有這一種語言的商店頁；英文放在詳細說明最後一段 |
| Store icon | build 產物的 `icons/icon-128.png` |
| 截圖 | `docs/webstore/screenshot-*.png`（1280×800、不能有 alpha）：正式版外掛在試翻頁 `https://naruhodo.page/zh-tw/try/?shot=1` 拍，再跑 `node scripts/store-images.ts` |
| Small promo tile | `docs/webstore/promo-small.png`（440×280） |
| Homepage URL | https://naruhodo.page/zh-tw/ |
| Support URL | https://github.com/yurenju/naruhodo-manga-translator/discussions（issue 只開放給 collaborator，使用者回報走 Discussions） |

說明裡不寫特定漫畫網站的名稱：列網站名稱會被當成關鍵字堆砌（Yellow Argon），也牽涉商標。

### 詳細說明

付費相關的文字照 Accepting Payment From Users 政策（[研究文件](../research/chrome-web-store-listing.md)第 6 節）：基本功能要付費的話寫清楚、公開銷售條款與退款政策、表明賣方是開發者而不是 Google。價格與頁數跟 onboarding（`src/onboarding/main.tsx`）一致，改價格時兩邊一起改。

```text
Naruhodo：邊看日文漫畫邊翻譯、邊學日文

點一下工具列圖示，Naruhodo 會找出畫面上的漫畫頁，把對話框直接換成繁體中文。翻頁或捲動時，新出現的頁面會自動翻譯。

■ 主要功能
・原地翻譯：譯文直接覆蓋在原本的對話框上，閱讀不中斷
・側邊欄逐字稿：依閱讀順序列出每句的原文、振り仮名與譯文，滑過對話框會同步標示
・學習模式：保留日文原稿，先看原文和讀音，想對答案時再揭露譯文
・跨頁支援：兩頁並排時自動分成兩頁各自翻譯
・角色與用語：自動整理角色名字與專有名詞，同一部作品的譯名前後一致
・翻譯快取：看過的頁面不用重翻，也不會重複扣頁數或花費
・匯出／匯入：在兩台電腦之間搬移作品、角色與用語與快取

■ 翻譯方式與費用
翻譯需要付費，有兩種方式，可以隨時在設定裡切換：
・內建翻譯（預設）：用 email 註冊，新帳號有 50 頁免費額度，不用輸入付款資料。用完之後要訂閱才能繼續翻譯：年繳 US$20（平均每月 US$1.67），每月可翻 800 頁。看過的頁面不扣頁數，翻譯失敗也不扣。
・自備金鑰：輸入你自己的 Claude API key（Anthropic），翻譯費用由你的 Anthropic 帳戶支付，用 Claude Haiku 每頁大約不到一美分，不需要註冊或訂閱。
沒有翻譯時也能用，但只會顯示原文與讀音。

■ 付款與退款
・訂閱由 Paddle.com（經銷商與 Merchant of Record）代開發者 Sad Coder, Inc. 銷售；賣方不是 Google，付款也不經過 Chrome Web Store。
・訂閱每年自動續訂，可以隨時取消：取消後到這一年結束前都能用，不會再扣款。
・每次付款後 14 天內可以全額退款，透過 Paddle 申請。詳見退款政策：https://naruhodo.page/refund/
・服務條款：https://naruhodo.page/terms/

■ 隱私
・對話框偵測和文字辨識（OCR）都在你的電腦上進行，圖片不會上傳，也不會送出網址。
・內建翻譯：辨識出的文字經過 Naruhodo 的服務交給 Anthropic 翻譯，服務不保存這些文字，只保存帳號需要的 email、登入紀錄、剩餘頁數、訂閱狀態與用量。
・自備金鑰：辨識出的文字用你的 key 直接送到 Anthropic，不經過 Naruhodo 的服務。
・開始翻譯前會先說明並徵求你的同意。外掛裡沒有分析或追蹤程式。
・外掛只在你點圖示的那個分頁作用，不會在背景讀取其他網站。
・詳見隱私權政策：https://naruhodo.page/privacy/

■ 使用前須知
・第一次使用時，會從 Hugging Face 下載文字辨識模型（大約 128 MB，支援 WebGPU 的電腦大約 472 MB）。
・需要 Chrome 116 以上。

■ 開源
原始碼以 MIT 授權公開在 GitHub：https://github.com/yurenju/naruhodo-manga-translator

---
English: Naruhodo: Japanese Manga Translator. It translates Japanese manga on the current tab into Traditional Chinese, in place, and lists the original text, furigana readings and translation side by side for language learners. Detection and OCR run locally. Translation is paid: sign up with your email for 50 free pages, then subscribe (US$20 billed yearly, about US$1.67 a month, 800 pages per month), or use your own Anthropic API key instead. The subscription is sold by Paddle.com, as reseller and Merchant of Record, on behalf of the developer, Sad Coder, Inc.; Google is not the seller. Refund policy: https://naruhodo.page/refund/
```

隱私權政策、服務條款、退款政策的網址是產品網站的 `/privacy/`、`/terms/`、`/refund/`（`site/src/pages/[doc].astro`，內容就是 repo 根目錄的 `PRIVACY.md`、`TERMS.md`、`REFUND.md`）。

## Privacy practices 分頁

### Single purpose

```text
Naruhodo translates Japanese manga shown in the current tab into Traditional Chinese and displays the translation in place over the original speech balloons. Text detection and OCR run locally in the browser; only the recognized Japanese text is sent for translation, either to the Naruhodo service (which uses the Anthropic API and keeps no copy of the text) for signed-in users, or directly to the Anthropic API with the user's own API key.
```

### Permission justification

**activeTab**

```text
Naruhodo only works on a tab after the user clicks the toolbar icon or presses the keyboard shortcut. activeTab grants temporary access to that tab so the extension can inject its overlay script and capture the visible area (tabs.captureVisibleTab) to find and read manga text. We request no host permissions, so the extension has no access to any site the user has not explicitly activated it on.
```

**scripting**

```text
Used with activeTab to inject the extension's bundled content script (content.js) into the tab the user activated. The content script locates manga pages on screen and draws the translated text over the speech balloons. No content scripts are declared statically, so nothing is injected into pages the user has not activated.
```

**sidePanel**

```text
The side panel is the extension's main UI: it shows translation progress, the original text with readings, the per-series glossary (Series Notes), the remaining page quota, settings for the translation mode (signed-in account or the user's own Anthropic API key), and import/export of the user's local data. It is opened when the user activates a tab.
```

**offscreen**

```text
An offscreen document crops the captured screenshots with canvas and runs the bundled ONNX Runtime Web (WebAssembly/WebGPU) for speech-balloon detection and OCR, and, when the user uses their own API key, calls the Anthropic Messages API with that key. Service workers have no DOM/canvas and cannot run these long-lived tasks, so this work has to happen in an offscreen document.
```

**storage**

```text
Stores small settings in chrome.storage.local: the translation mode (Hosted Translation or the user's own API key), the Page Mode preference (single page or two-page spread), progress through the setup pages, whether the Hosted Translation hint was dismissed, and, for each translation mode, whether the user has accepted the in-product data disclosure (with the disclosure version). No personal data is stored in chrome.storage.
```

**unlimitedStorage**

```text
On first use the extension downloads the OCR and text-detection model weights (about 128 MB, or about 472 MB when WebGPU is available) from Hugging Face and keeps them in Cache Storage so they are not downloaded again. It also keeps a local translation cache and glossary per manga series in IndexedDB. These exceed the default storage quota, and evicting the models would force repeated large downloads.
```

### Remote code

選「No, I am not using remote code」。

```text
All JavaScript and WebAssembly, including ONNX Runtime Web, is bundled in the package. The extension downloads ONNX model weights (data files, not code) from Hugging Face at a pinned revision and verifies their SHA-256 hashes.
```

### Data usage

| 類別 | 勾不勾 | 理由 |
|---|---|---|
| Personally identifiable information | 勾 | 內建翻譯的 email：存在 Worker 的 D1（`accounts`）與外掛的 IndexedDB（session），寄驗證碼時交給 Resend |
| Website content | 勾 | 截圖與 OCR 文字；文字會送到 Worker（內建翻譯）或直接送到 Anthropic（自備金鑰） |
| Authentication information | 勾 | 自備金鑰的 Anthropic API key（存在本機，放在 header 送到 Anthropic）；內建翻譯的 session token（存在本機，Worker 只存 hash）與 email 驗證碼 |
| Web history | 勾 | 作品與網址對應（origin＋path）存在本機 |
| Financial and payment information | 不勾 | 卡號、帳單地址在 Paddle 的 checkout 裡輸入，Worker 與外掛都拿不到；Worker 只存 Paddle 的 subscription／customer id 與訂閱狀態 |
| 其他類別 | 不勾 | 沒有收集 |

三項 Limited Use 聲明全部勾。

Privacy policy URL：https://naruhodo.page/privacy/

## Distribution 分頁

| 欄位 | 內容 |
|---|---|
| Visibility | Public |
| Regions | All regions（稅務與受制裁地區由 Paddle 處理） |

## Test instructions

審核員用自己的 email 註冊，拿 50 頁 Free Pages 測完所有功能（spec #86 user story 60），不用另外準備測試 key 或帳號，Username／Password 欄位留空。測試頁用自己網站的試翻頁（#169，不扣頁數），onboarding 第 4 步本來就會帶過去，也不依賴第三方漫畫網站。

這個欄位最多 500 字，所以只留步驟，按鈕直接寫中文讓審核員照字找。改了 onboarding 的按鈕文字（`src/onboarding/main.tsx`）時這裡要一起改。

```text
No test account needed: sign up with any email. New accounts get 50 free pages, no payment needed.
1. The setup page opens on install. Click 開始設定.
2. Enter your email, click 同意並寄送驗證碼, enter the emailed code.
3. Click 先用免費的 50 頁.
4. Click 到試翻頁試試看 to open https://naruhodo.page/zh-tw/try/ (uses no pages).
5. Click the toolbar icon (Alt+Shift+M; Mac: ⌥⇧M): balloons turn into Chinese; the side panel lists original, readings, translation.
6. Gear menu > 設定: account, pages, Subscribe, Delete account.
```
