# Chrome Web Store 上架研究

研究日期：2026-10-28。只引用 developer.chrome.com 一手文件（第 8 題另用一頁 developers.google.com 的 OAuth 文件）。引文都是短句，其餘是摘要。「官方未明載」表示查到的官方頁面沒寫，後面附上判斷依據。

## 結論摘要

1. **模型權重不算 remotely hosted code。** 官方的 AI 外掛指南寫明「models are not considered remote hosted code」。ORT 的 wasm／JS 打包在套件裡，`'wasm-unsafe-eval'` 本來就在 MV3 最低 CSP 裡。表單選「No, I am not using remote code」。
2. **`fonts/*` 對 `<all_urls>` 開放（已不適用：2026-11-05 起不打包字型，見第 2 題）：** 官方沒寫這會被追問，它也不是權限、不會出安裝警告；唯一的代價是網站可以探測到外掛有裝。`use_dynamic_url`（Chrome 130+）可以降低被探測的程度，但要把 `minimum_chrome_version` 從 116 調高，而且官方沒寫清楚它跟 `getURL()` 怎麼搭配。
3. **揭露：** 資料類別勾「Website content」與「Authentication information」，「Web history」建議也勾（理由見第 3 題）；三項 Limited Use 聲明都可以照實勾；必須有隱私權政策 URL。2026-08-01 起，揭露政策改成**所有**資料收集都要 prominent disclosure，不論是否跟 single purpose 密切相關。所以 BYOK、使用者主動點擊都不能免除。要在 side panel 做一個第一次翻譯前的揭露與同意畫面。
4. 這六個權限在官方權限清單上都沒有安裝警告。justification 範例與 single purpose 範例見第 4 題（英文）。深入審查的觸發點主要是寬 host 權限、新開發者與新項目、大幅改版，本外掛只會碰到後兩項。
5. **必要素材**只有 128×128 icon（圖案 96×96，四邊各 16 px 透明 padding）和至少 1 張截圖（1280×800 或 640×400，最多 5 張）。small promo tile 440×280、marquee 1400×560、YouTube 影片都是選填，但沒有 small tile 的項目排序會比較後面。
6. **trader 的聯絡資訊（含電話、地址）會公開在 listing 底部；non-trader 則會告知 EU 消費者，消費者保護權利不適用。** 打算用 Paddle 收費、又有公司，應以公司身分宣告 trader。官方有記載用「Trader → Non-Trader → Trader」重新驗證的方式，所以身分之後可以改。
7. 註冊費 US$5（一次性），發佈前必須開 2-Step Verification。開發者 email 建立後不能改，一個帳號一生只能多建 1 個 publisher，項目轉移要走 support 表單，新 publisher 一開始最多只能有 2 個已發佈的外掛。建議用公司專用的 Google 帳號註冊。
8. 用 **API v2**：v1／v1.1 只支援到 2026-10-15，已經過期。v2 沒有「建立項目」的方法，**第一次上架必須在 Dashboard 手動建立並填完 listing 與 Privacy 分頁**。之後 GitHub Actions 用 service account（一個 publisher 只能連一個）或 OAuth refresh token 呼叫 `:upload` 與 `:publish`。
9. **審核時間**大多幾天，最長可能幾週，超過三週可以聯絡支援。跟本外掛最相關的退件代碼是 Purple Nickel（缺 in-product 揭露）、Purple Lithium（隱私權政策）、Yellow Magnesium（審查員沒有 API key、測不到功能）、Yellow Argon（listing 堆砌網站名稱）、Purple Potassium（權限過多）。

---

## 程式碼現況（研究結論以此為準）

| 項目 | 實際行為 | 位置 |
|---|---|---|
| 權限 | `activeTab`、`scripting`、`sidePanel`、`offscreen`、`storage`、`unlimitedStorage`。正式 build 沒有 host_permissions（e2e build 才加 `<all_urls>`），也沒有靜態 content_scripts | `src/manifest.ts` |
| 啟動 | 使用者點工具列圖示，或按快捷鍵 `Alt+Shift+M`（`commands`），之後 `scripting.executeScript` 注入 `content.js`，並開 side panel | `src/background/index.ts`、`activation.ts` |
| 截圖 | `chrome.tabs.captureVisibleTab` 截可視區域（靠 activeTab 授權），在 offscreen document 裡裁切並跑 OCR，**圖片不會離開本機** | `src/background/index.ts`、`src/offscreen/index.ts` |
| ORT | `onnxruntime-web` 的 `.mjs` 與 `.wasm` 在 build 時複製到 `ort/`，執行時用 `chrome.runtime.getURL('ort/...')` 動態 import 套件內的檔案 | `scripts/build.ts`、`src/offscreen/ort-engine.ts` |
| 模型 | 從 `https://huggingface.co/{repo}/resolve/{固定 revision}/{path}` 下載，驗證 SHA-256，存在 Cache Storage | `src/offscreen/models/model-files.ts`、`model-store.ts`、`local-pipeline.ts` |
| 翻譯 | offscreen document 直接 `fetch https://api.anthropic.com/v1/messages`，header 帶 `x-api-key` 與 `anthropic-dangerous-direct-browser-access`。送出的內容是 OCR 出來的日文、前幾頁的原文與譯文（Prior Pages），以及 Series Notes（譯名表）。**不送圖片、不送網址** | `src/offscreen/claude-translator.ts`、`src/shared/translator.ts` |
| API key | 存在外掛 origin 的 IndexedDB `naruhodo` → store `apiKeys`，**沒有加密**（spec 第 5 節的取捨）。只有 offscreen 與 side panel 讀值，畫面只顯示末四碼，匯出檔不含 key | `src/shared/api-key-store.ts`、`src/background/backup.ts` |
| 其他本機資料 | IndexedDB 存了 `activeTabs`、`series`、`pageTranslations`（每頁的原文、譯文與座標）、`urlPatterns`（使用者把某頁歸類到 Series 後，記住 origin＋path，忽略 query 與 hash）、`seriesNotes`、`notesSuggestions`。`chrome.storage.local` 只存 Page Mode | `src/shared/db.ts`、`src/shared/series.ts`、`src/shared/page-mode.ts` |
| 對外連線 | 只有 huggingface.co（下載模型）與 api.anthropic.com（翻譯）。**沒有 analytics、沒有 telemetry、沒有自己的伺服器**。trace 只在 debug build 印到 console | grep `https://`、`src/shared/trace.ts` |
| 現有的提示文字 | 設定區有一段 hint：建議建立專用 key、設花費上限，並說明 key 只存在本機。**但沒有說會把頁面文字送到 Anthropic，也沒有同意按鈕** | `src/sidepanel/main.tsx` |

---

## 1. 執行時下載 ONNX 模型權重算不算 remotely hosted code？

**官方定義。** RHC 是「anything that is executed by the browser that is loaded from someplace other than the extension's own files」，包括 JavaScript 與 WASM。資料不算，官方舉的例子是 JSON、CSS。MV3 的額外要求頁寫的是：外掛可以載入外部資料，但那些資源「must not contain any logic」。禁止的例子有三種：`<script>` 指向套件外、對遠端字串 `eval()`，以及自己寫一個 interpreter 去執行遠端抓來的複雜指令（即使指令是以資料形式送來）。

**對模型的明確說法。** Chrome 的「Extensions and AI」指南直接寫了「Note that models are not considered remote hosted code.」，還建議大型模型在安裝後才觸發下載，並把模型的生命週期和外掛版本分開管理，免得每次更新都要重新下載。本外掛就是這樣做的：第一次使用才下載，存在 Cache Storage，以 revision 與 SHA-256 固定版本。

**判斷。**
- ONNX 檔描述的是張量運算圖，由套件內的 ORT 執行，碰不到 DOM，也碰不到 extension API，跟「interpreter 執行遠端指令」的禁止例子不同。官方又明說 model 不算 RHC，所以風險低。
- **wasm 打包在套件裡**是關鍵：會被執行的程式碼（`ort/*.mjs`、`ort/*.wasm`）全部來自外掛自己的檔案，符合「must bundle all executable code」。如果改成從 CDN 載入 ORT 的 wasm（ORT 預設的 `wasmPaths` 行為），就會變成 RHC。所以 `ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/')` 這行不能拿掉。
- **`'wasm-unsafe-eval'`**：manifest CSP 文件列出的 extension_pages 最低政策就是 `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`，所以它是允許的。不允許的是 `'unsafe-eval'`，加了會在安裝時報錯。本外掛的 CSP 與最低政策完全一致。
- 固定 revision 加 SHA-256 驗證，也讓「完整功能可以從送審的程式碼看出來」這點成立：審查員看得到要下載哪幾個檔、怎麼驗證。

**表單怎麼答。** Privacy practices 分頁的 remote code 問題選 **「No, I am not using remote code」**。官方說明頁只引用了這個選項的字樣，選 No 時就沒有填理由的欄位（官方頁面沒有列出另一個選項的完整字樣）。不必為了模型改選 Yes：官方說選 Yes 會受到額外審查、審核時間也比較長，而模型本來就不算 RHC。

建議在 **Test instructions** 或 description 補一句（英文），先回答審查員可能的疑問：

> On first use the extension downloads ONNX model weights (data only, no executable code) from Hugging Face at pinned revisions and verifies their SHA-256 hashes. All executable code, including the ONNX Runtime Web JavaScript and WebAssembly, is bundled in the package.

出處：
- https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- https://developer.chrome.com/docs/extensions/ai
- https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy

## 2. `web_accessible_resources` 對 `<all_urls>` 開放 `fonts/*`

> 2026-11-05 更新：覆蓋層改用系統字型、不再打包字型，manifest 已經沒有 `web_accessible_resources`，這題不用再處理。以下是當時的研究。

**官方說法。** 資源預設不是 web accessible，官方給的理由是避免惡意網站 fingerprint 已安裝的外掛，或利用外掛裡的 XSS 之類漏洞。`matches` 只看 origin。`use_dynamic_url: true` 會讓資源只能透過每個 session 產生的動態 ID 存取，這個 ID 在瀏覽器重開或外掛重載時重新產生。Chrome 130 起支援這個屬性。

**會不會被追問？** 官方未明載。判斷依據如下：
- 權限警告文件與權限清單只處理 `permissions`／`host_permissions`，WAR 不是權限，不會出現安裝警告。
- 審核流程文件列出會額外審查的是寬 host 權限（`<all_urls>`、`*://*/*`）、危險權限、大幅改版、新開發者，沒有提到 WAR。
- 開放的只有 woff2 字型與 LICENSE，沒有 HTML 或 JS，所以官方擔心的 XSS 面幾乎不存在，剩下的只有「網站能探測到外掛有裝」。

結論：被追問的機率低。可以在 Test instructions 補一句「fonts/* is web-accessible only because the injected content script fetches the overlay font from the page origin; it exposes only font files.」，先講清楚。

**替代方案與取捨。**

| 做法 | 優點 | 代價 |
|---|---|---|
| 維持現狀 | 簡單，Chrome 116 起都能用 | 任何網站都能 `fetch chrome-extension://<固定 ID>/fonts/...` 探測外掛 |
| 加 `use_dynamic_url: true` | URL 每個 session 換一次，固定 ID 探測不到 | 要把 `minimum_chrome_version` 從 116 拉到 130；官方查到的頁面沒有寫 `runtime.getURL()` 會不會自動回傳動態 URL（官方未明載），採用前要實測。動態 ID 在單次 session 內還是可能被同頁的腳本觀察到 |
| 取消 WAR，改由 SW／offscreen 讀字型，再用 message 把 bytes 傳給 content script，用 `new FontFace(name, buffer)` 載入 | 完全不對網頁開放任何資源 | 字型子集共約 3.5 MB，要依 unicode-range 只傳用得到的子集；message 序列化有成本，要改 `src/content/overlay-font.ts` |

建議：上架第一版維持現狀，不影響審核；之後若在意被探測，優先考慮第三種做法，不必為了 `use_dynamic_url` 調高 Chrome 版本。

出處：
- https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
- https://developer.chrome.com/blog/extension-news-january-2025
- https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
- https://developer.chrome.com/docs/webstore/review-process

## 3. 把 OCR 文字送到 Anthropic API 的揭露方式

### 3.1 政策重點

- **「handle」的範圍很廣**：收集、傳輸、使用、分享都算，**只在本機處理或儲存也要揭露**。user data 的例子包括 website content（擷取頁面內容、截圖）與 authentication information。
- **隱私權政策**：只要處理任何 user data，就必須在 Dashboard 填一個準確、最新的隱私權政策 URL，只存在本機也一樣。政策內容要跟 Dashboard 的揭露、實際行為一致，不一致就是違規，嚴重時整個 publisher 的項目都會被停權。
- **Prominent disclosure**：政策寫的是「If your Product handles any user data」，在收集前要揭露收集哪些資料、怎麼用，並取得「affirmative and informed consent」。User Data FAQ 進一步寫明：揭露要出現在產品 UI 裡、在收集之前；只放在隱私權政策裡不夠，store listing 也不算。
- **2026-07-01 公告、2026-08-01 起執行的修訂**：Disclosure Requirements 改成所有資料收集都要 prominent disclosure，「regardless of whether the data is closely related to the extension's single purpose」。Limited Use 也收緊成資料必須是 single purpose「strictly necessary」的。
- **傳輸與儲存**：傳輸必須用現代加密（HTTPS），authentication information 要妥善保管。FAQ 另寫靜態儲存的資料「should」用強加密（例如 AES）；Purple Copper 的說明則建議不要把 user data 放在 query string 或 header。

### 3.2 BYOK、使用者主動點擊的情境要不要 in-product disclosure？

**要。** 依據：
1. 2026-08-01 起的新文字明確取消了「跟 single purpose 密切相關就不必揭露」的空間。
2. FAQ 說 store listing 與隱私權政策都不算 prominent disclosure；FAQ 第 13 題也說，只是一個揭露資料收集的對話框，本身不算「user-facing feature」。
3. 查到的官方頁面都沒有寫「使用者自備 key」或「使用者主動點擊」可以豁免（官方未明載）。FAQ 第 15 題只豁免連到**使用者指定伺服器**的 FTP／IRC 類 client 的 Limited Use；Anthropic 是外掛寫死的端點，套不上。

**建議做法。** 在 side panel 第一次要送翻譯前（或儲存 API key 時）顯示一張揭露卡片，使用者按下「同意並啟用翻譯」之後才送出第一個請求，同意狀態存在外掛 origin。卡片內容大致如下：
- 啟動後外掛會截取這個分頁的可視畫面，**截圖只在本機**用來偵測對話框與 OCR，不會上傳。
- 辨識出來的**日文文字**、前幾頁的原文與譯文，以及這部作品的譯名表，會用**你的 API key** 直接送到 Anthropic（api.anthropic.com）翻譯，並受 Anthropic 的條款與隱私權政策約束。不會送圖片，也不會送網址。
- API key、翻譯快取、作品與網址對應只存在這台電腦，開發者收不到任何資料，外掛沒有任何分析追蹤。
- 第一次使用會從 Hugging Face 下載模型（約 128 MB，WebGPU 時約 472 MB）。
- 附上隱私權政策連結，以及「不同意」的選項（不同意就不送翻譯，可以只看 OCR 結果，或關掉外掛）。

現有設定區的 hint 文字不夠：它沒有提到文字會送到 Anthropic，也沒有同意動作。之後如果資料流有變（例如改走自己的伺服器、加上 Paddle 授權驗證），依政策要再主動揭露一次。

### 3.3 Privacy practices 分頁的資料類別

官方說明頁只寫了「第一組勾選資料類型、第二組勾選遵守聲明」，類別名稱與定義只出現在截圖裡，文字頁面沒有列出。以下類別名稱取自 Dashboard 表單，與 User Data FAQ 的資料類型對照；每類的定義以表單上的說明文字為準（本研究無法用公開文件逐字核對，屬官方文件未明載）。

| 類別 | 建議 | 理由（對照程式碼） |
|---|---|---|
| Website content | **勾** | 截圖、OCR 出的頁面文字、譯文快取都是頁面內容，其中文字會送到 Anthropic |
| Authentication information | **勾**（保守） | FAQ 舉的例子是登入資訊、密碼、驗證 cookie，沒有直接提到 API key（官方未明載）。但 Anthropic API key 就是使用者在第三方服務的憑證：外掛會儲存它，並在 header 裡送給 Anthropic。勾了比較不會被認為揭露不完整 |
| Web history | **建議勾**（保守） | `urlPatterns` 會記住使用者歸類過的頁面 origin＋path，用來自動辨識作品。資料只存在本機，但 FAQ 說本機處理也算 handle。要搭配 listing 描述「記住哪些網址屬於哪部作品」這個 user-facing feature，對應 Purple Magnesium 的要求 |
| User activity | 不勾 | 沒有記錄點擊、鍵盤或滑鼠軌跡 |
| Personally identifiable information、Health information、Financial and payment information、Personal communications、Location | 不勾 | 沒有收集。之後接 Paddle 時要重新評估，金流由 Paddle 處理，但外掛如果存 email 或授權碼，就要重評 |

**三項 Limited Use 聲明**（Dashboard 上的遵守聲明；官方 Limited Use 頁面列的是四項要求，表單把它們整理成勾選項目）都可以照實勾：
1. 不在核准用途之外把 user data 出售或移轉給第三方。送到 Anthropic 是 single purpose 必要的移轉，屬於允許的移轉。
2. 不把 user data 用在跟 single purpose 無關的用途。
3. 不用 user data 判斷信用或放貸。

另外，Limited Use 頁面要求在外掛的網站（homepage，或點一下就能到的頁面）公開聲明遵守 Limited Use。官方範例句：「will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements」。

### 3.4 隱私權政策必備內容

官方要求寫出：收集什麼、怎麼用、分享給誰（哪些第三方）；FAQ 另建議涵蓋安全、存取與刪除、保存期限。對應本外掛：

- **收集與處理**：可視畫面截圖（只在本機）、OCR 文字、譯文與快取、作品名稱與網址對應、譯名表、Anthropic API key（本機 IndexedDB，未加密，見下方）、Page Mode 設定。
- **分享對象**：Anthropic。送出日文文字、前文與譯名表，用使用者自己的 key，附上 Anthropic 隱私權政策連結。Hugging Face：只下載模型，請求本身會讓 Hugging Face 看到 IP 與一般 HTTP 資訊，不送 user data。除此之外沒有其他對象，沒有 analytics。
- **安全**：傳輸一律 HTTPS。API key 只有外掛自己的頁面讀得到，content script 與網頁都讀不到，也不會出現在匯出檔。
- **保存與刪除**：資料保存在本機，直到使用者刪除（設定區的「刪除」key、移除外掛就會清掉）。翻譯快取不會自動清除。
- **Limited Use 聲明句**、聯絡方式、生效日期，以及政策變更時的通知方式。
- 隱私權政策不要寫在 description 裡，要填在 Dashboard 的專用欄位（Purple Lithium 的常見錯誤）。

**風險提醒（官方用語是 should）：** FAQ 說靜態儲存的資料「should」用強加密。目前 API key 是明文存在 IndexedDB（spec 第 5 節的刻意取捨）。官方沒有說明這會不會單獨構成退件（官方未明載）。建議在隱私權政策照實寫出「存在本機、只有外掛能存取」；如果要更保險，可以用 WebCrypto 產生一把 non-extractable 的 AES key 存在 IndexedDB，再拿它加密 API key。這不防本機惡意程式，但符合字面要求。

出處：
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements
- https://developer.chrome.com/docs/webstore/program-policies/limited-use
- https://developer.chrome.com/docs/webstore/program-policies/data-handling
- https://developer.chrome.com/docs/webstore/program-policies/policies
- https://developer.chrome.com/blog/cws-policy-updates-2026
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/troubleshooting

## 4. 權限 justification 與 single purpose

**警告與審查。** 官方權限清單上，這六個權限都沒有列出安裝警告。permission-warnings 頁特別寫 activeTab「does not display a permission warning」。確認方式：在 `chrome://extensions` 把外掛打包成 `.crx` 再拖進去，看實際出現的警告。審核流程頁列出需要更多時間審查的因素：新開發者與新項目、危險權限、大幅改版、寬 host 權限、程式碼的量與格式（minified 較難審，obfuscation 不允許，一般 minify 可以）。本外掛沒有 host_permissions，會碰到的是「新開發者與新項目」，以及 minified 的 `ort.webgpu.bundle.min.mjs`；開源 repo 連結可以放在 description 或 Test instructions。另外，Use of Permissions 政策要求只申請最窄的權限，也不能為還沒做的功能預先申請。

**依據：** activeTab 讓使用者執行 action、鍵盤快捷鍵（commands）、context menu 或 omnibox 之後，暫時取得當前分頁的存取權，配合 `scripting` 才能 `executeScript`。`tabs.captureVisibleTab` 需要 `<all_urls>` 或 `activeTab`，每秒最多 2 次。`sidePanel.open()` 必須由使用者動作觸發，Chrome 116+。offscreen 的 `BLOBS` reason 涵蓋處理 Blob 物件。`unlimitedStorage` 會解除 `chrome.storage.local`、IndexedDB、Cache Storage、OPFS 的配額。`storage.local` 預設對 content script 開放（`setAccessLevel` 可以改）。

**Single purpose 範例：**

> Naruhodo translates Japanese manga shown in the current tab into Traditional Chinese and displays the translation in place over the original speech balloons. Text detection and OCR run locally in the browser; only the recognized Japanese text is sent to the Anthropic API, using the user's own API key, for translation.

**各權限 justification 範例：**

- **activeTab**
  > Naruhodo only works on a tab after the user clicks the toolbar icon or presses the keyboard shortcut. activeTab grants temporary access to that tab so the extension can inject its overlay script and capture the visible area (tabs.captureVisibleTab) to find and read manga text. We request no host permissions, so the extension has no access to any site the user has not explicitly activated it on.
- **scripting**
  > Used with activeTab to inject the extension's bundled content script (content.js) into the tab the user activated. The content script locates manga pages on screen and draws the translated text over the speech balloons. No content scripts are declared statically, so nothing is injected into pages the user has not activated.
- **sidePanel**
  > The side panel is the extension's main UI: it shows translation progress, the original text with readings, the per-series glossary (Series Notes), settings for the user's Anthropic API key, and import/export of the user's local data. It is opened when the user activates a tab.
- **offscreen**
  > An offscreen document crops the captured screenshots with canvas and runs the bundled ONNX Runtime Web (WebAssembly/WebGPU) for speech-balloon detection and OCR, then calls the Anthropic Messages API with the user's key. Service workers have no DOM/canvas and cannot run these long-lived tasks, so this work has to happen in an offscreen document.
- **storage**
  > Stores a single UI preference (Page Mode: single page or two-page spread) in chrome.storage.local so the side panel and content script share it across tabs and browser restarts. No personal data is stored in chrome.storage.
- **unlimitedStorage**
  > On first use the extension downloads the OCR and text-detection model weights (about 128 MB, or about 472 MB when WebGPU is available) from Hugging Face and keeps them in Cache Storage so they are not downloaded again. It also keeps a local translation cache and glossary per manga series in IndexedDB. These exceed the default storage quota, and evicting the models would force repeated large downloads.

注意：offscreen 的 justification 是寫給審查員看的表單文字，跟 `createDocument` 的 `justification` 參數不同；後者可能顯示給使用者（目前是 `'Crop screenshots of manga pages'`）。官方沒有要求 reason 一定要跟實際用途完全一致（官方未明載），但目前只宣告 `BLOBS`、實際上也跑 wasm／WebGPU 與 fetch，表單上照實寫比較安全。如果 OCR 改用 Worker，可以考慮加上 `WORKERS` reason。

出處：
- https://developer.chrome.com/docs/extensions/reference/permissions-list
- https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
- https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- https://developer.chrome.com/docs/extensions/reference/api/tabs
- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/reference/api/storage
- https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines
- https://developer.chrome.com/docs/webstore/review-process
- https://developer.chrome.com/docs/webstore/program-policies/policies

## 5. 商店素材規格

| 素材 | 規格 | 必要？ |
|---|---|---|
| Store icon | 128×128 PNG，要包含在 ZIP 裡。方形圖案 96×96，四邊各 16 px 透明 padding；圓形直徑約 112 px；接近方形的圖案佔寬度 75–80%。深色、淺色背景都要清楚（偏深色的加一點白色外光暈）；不要大陰影、不要加邊框。沒有 alpha 的圖會被放進圓角 12 px 的框 | **必要** |
| 截圖 | 1280×800（建議）或 640×400；目前一律縮成 640×400 顯示。方角、滿版、不留 padding；至少 1 張、最多 5 張，要呈現目前版本的實際畫面，少放文字 | **至少 1 張** |
| Small promo tile | 440×280，PNG 或 JPEG。沒有的話，在首頁、分類頁、搜尋結果的排序會比較後面 | 選填（建議做） |
| Marquee promo tile | 1400×560，PNG 或 JPEG。沒有就不能上首頁輪播 | 選填 |
| YouTube 影片 | 填連結，可以取代或搭配截圖 | 選填 |
| 文字 | Detailed description 必填（官方沒有寫字數上限）；summary 就是 manifest 的 `description`，最多 132 字、純文字 | 必要 |

其他：listing 必須填 category 與 language；可以選填 Official URL（要先在 Google Search Console 驗證網站）、Homepage URL、Support URL。description、截圖、影片可以依 locale 本地化，promo tile 不行。

**對本外掛：**
- `src/icons/icon-128.png` 要檢查是否符合 96＋16 padding 的規範（目前由 `scripts/icons.ts` 從 SVG 產出）。
- manifest 的 `description` 是中文，預設 locale 的 listing 也會用它。若要同時上英文 listing，要改用 `_locales`。
- 截圖裡會出現他人的漫畫畫面，涉及 Impersonation & IP 政策（官方未針對截圖明載）。建議用自有或授權的測試素材（例如 e2e mock site），不要放出版社或網站商標。

出處：
- https://developer.chrome.com/docs/webstore/images
- https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- https://developer.chrome.com/docs/webstore/best-listing
- https://developer.chrome.com/docs/extensions/reference/manifest/description
- https://developer.chrome.com/docs/webstore/program-policies/listing-requirements

## 6. Trader／Non-trader（EU DSA）

- **定義**（沿用歐盟定義）：trader 是為了自己的行業、事業、手藝或專業而行事的自然人或法人；non-trader 則不是。所有開發者都要自行宣告，Google 不會替你判斷個案。
- **宣告 non-trader 的後果**：會告知 EU 消費者，消費者保護法的權利不適用於他們和這位開發者之間的契約。
- **宣告 trader 要提供並公開的資訊**：CWS 會收集法定名稱、聯絡資料，可能還要其他識別文件。FAQ 寫明 trader 資訊會公開在 listing 底部，**電話號碼會顯示在 listing 上**，地址請用你願意公開的。個人 trader 要用能收簡訊的電話；公司目前也要能收簡訊的電話，D-U-N-S 對應電話的支援要等之後才會加入，目前也不能用 D-U-N-S 驗證。驗證需要建立 Google Payments profile；Workspace 帳號如果被網域管理員關掉 Payments，會出現 OR_AMR_01 錯誤。
- **之後要收費（公司＋Paddle）的影響**：
  - 官方未明載「開始收費就必須改宣告 trader」。但開始收費就是為了事業目的締約，依定義應宣告 trader，而且要用公司的資料。
  - Accepting Payment From Users 政策要求：如果基本功能需要付費，安裝時的說明要寫清楚；要公開銷售條款（含退款政策）；要表明賣方是開發者而不是 Google；付款與個資要依法和 PCI 規範安全處理。用 Paddle 時，卡號由 Paddle 處理，但外掛如果開始處理 email 或授權資訊，Privacy 分頁與隱私權政策要更新，並依揭露政策主動告知使用者（見第 3 題）。
- **能不能之後改？** 可以。FAQ 記載用「Trader → Non-Trader → Trader」重新開始驗證，也用來修正誤註冊成個人、其實要以公司身分註冊的情況。改國家、電話、名稱、D-U-N-S 都要重新驗證；同國家內改地址可以在 Google Payments 設定裡改。官方沒寫切換期間 listing 會怎樣（官方未明載）。
- **建議**：現在是開源、免費、個人維護，可以宣告 non-trader，但要接受消費者保護不適用的提示。既然已經規劃公司與 Paddle，比較乾淨的做法是一開始就用公司帳號宣告 trader，避免之後重新驗證、聯絡資訊從個人換成公司，也不會讓個人電話先曝光。

出處：
- https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure
- https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq
- https://developer.chrome.com/docs/webstore/program-policies/policies（Accepting Payment From Users）

## 7. 開發者帳號

- **註冊費**：一次性。Developer Agreement 寫金額由 Google 決定；2026-04-28 的官方部落格寫建立新 publisher「仍需」US$5 註冊費。註冊時要接受協議與政策，而且所在國家或地區要在支援清單上。
- **2-Step Verification**：發佈或更新外掛前必須開啟。
- **身分驗證**：查到的官方頁面裡，跟身分驗證有關的只有 trader 驗證（第 6 題）。註冊頁沒有描述其他身分驗證流程（官方未明載）。
- **Email 不能改**：帳號建立後 email 就不能改，要換的話只能開新帳號、用 support 表單轉移項目。官方建議用一個專門發佈用、會定期查看的 email。
- **Publisher 與成員（2026-04 改版）**：不再區分個人與群組 publisher，也不再用同步 Google Group 的方式。現在用「Invite member」邀請成員，角色有 Viewer、Item Manager、Editor、Admin，每個 publisher 至少要有一位 Admin。受邀成員不用付註冊費。註冊時會自動建立一個 publisher，之後可以再建一個，但**「You can only create one publisher in your account lifetime」**，刪掉也不會恢復名額。舊的群組 publisher 已經遷移：原本的 Admin 維持 Admin，Member 變成 Editor。
- **項目轉移**：透過 support 表單轉給其他開發者。官方沒寫轉移的條件與時間（官方未明載）。
- **發佈數量限制**：新 publisher 一開始最多只能有 2 個已發佈的外掛，可以申請提高。
- **個人 Google 帳號 vs 公司帳號**：

| | 個人帳號 | 公司專用帳號（或 Workspace） |
|---|---|---|
| 註冊 email | 之後不能改，個人信箱會綁定 | 用 `publish@公司網域` 之類的專用信箱，之後不受人事異動影響 |
| trader 資訊 | 若宣告 trader，個人的電話與地址會公開在 listing | 公開公司資料；Workspace 要確認網域管理員有開放 Google Payments |
| 交接與協作 | 只能邀請成員，擁有者還是個人 | 擁有者是公司，個人用自己的帳號以成員身分加入 |
| 轉移成本 | 日後轉給公司要走 support 表單 | 不用轉移 |

建議：**直接用公司專用帳號註冊**（開 2SV），Yuren 的個人帳號以 Admin 成員身分加入。CI 用的 service account 也掛在這個 publisher 下。

出處：
- https://developer.chrome.com/docs/webstore/register
- https://developer.chrome.com/docs/webstore/group-publishers
- https://developer.chrome.com/blog/cws-role-expansion-developer-dashboard
- https://developer.chrome.com/docs/webstore/program-policies/terms
- https://developer.chrome.com/docs/webstore/publish
- https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq

## 8. Chrome Web Store API 與 GitHub Actions

**版本**：使用 **v2**（`chromewebstore.googleapis.com/v2`）。V1 的參考頁寫著「deprecated and will only be supported until 15th October 2026」，研究日期時已經過期。v1.1 有 `POST .../upload/chromewebstore/v1.1/items` 可以建立新項目，**v2 沒有建立項目的方法**。

**首次上架必須手動**：在 Dashboard 按「Add new item」上傳 ZIP，填完 Store listing、Privacy、Distribution（以及 Test instructions），再送審。官方 API 指南也寫明，新項目要先在 Dashboard 填好 Store listing 與 Privacy 分頁。取得 extension ID 之後，後續版本才交給 CI。

**驗證方式二選一：**

A. **Service account**（建議用於 CI）
1. 在 Google Cloud Console 建立或選擇 project，啟用 Chrome Web Store API。
2. 建立 service account，這一步不需要授予任何 IAM 角色。
3. 在 Developer Dashboard 的 Account 區塊加入這個 service account 的 email。**一個 publisher 只能連一個 service account。**
4. 取得 token。官方列出兩種方式：用 `gcloud auth print-access-token --impersonate-service-account=...`（呼叫者需要 `roles/iam.serviceAccountTokenCreator`），或建立 JSON key、自己簽 JWT 換 access token（官方提醒 key 檔有安全風險）。scope 是 `https://www.googleapis.com/auth/chromewebstore`。官方頁面沒有提到 Workload Identity Federation（官方未明載）。在 GitHub Actions 上最簡單的做法是把 JSON key 放進 repository secret；或用 GitHub OIDC 搭配 WIF 和 impersonation，但這條路官方沒有寫，要自己驗證。

B. **OAuth client＋refresh token**
1. 同一個 project 設定 OAuth consent screen（External，把自己加成 test user）。
2. 建立「Web application」類型的 OAuth client，redirect URI 加上 `https://developers.google.com/oauthplayground`。
3. 在 OAuth Playground 用自己的 client 授權上面的 scope，用擁有這些項目的帳號登入，換到 refresh token。
4. CI 每次 `POST https://oauth2.googleapis.com/token`（帶 `client_id`、`client_secret`、`refresh_token`、`grant_type=refresh_token`）取得 access token，有效期約 3600 秒。
5. **陷阱**：Google OAuth 文件寫明，consent screen 是 External 且狀態為「Testing」時，refresh token 7 天就會過期。CI 要長期用的話，得把 consent screen 發佈成 production，或改用 service account。

**Endpoints（v2）：**
- 上傳：`POST https://chromewebstore.googleapis.com/upload/v2/publishers/{PUBLISHER_ID}/items/{EXTENSION_ID}:upload`（body 是 zip）
- 查狀態：`GET https://chromewebstore.googleapis.com/v2/publishers/{PUBLISHER_ID}/items/{EXTENSION_ID}:fetchStatus`（上傳回 `UPLOAD_IN_PROGRESS` 時用它輪詢）
- 送審並發佈：`POST https://chromewebstore.googleapis.com/v2/publishers/{PUBLISHER_ID}/items/{EXTENSION_ID}:publish`。body 選填 `publishType`（`DEFAULT_PUBLISH` 審過就上線／`STAGED_PUBLISH` 審過先暫存）、`deployInfos[].deployPercentage`、`skipReview`（API 判斷不符資格就回錯誤）、`blockOnWarnings`
- 分階段推送：`:setPublishedDeployPercentage`，只適用 7 日活躍使用者超過 10,000 的項目
- 撤回送審：`:cancelSubmission`

`PUBLISHER_ID` 在 Dashboard 的 Publisher > Settings 頁。每次上傳 manifest 的 `version` 都必須比上一版大，這點現有 release workflow 已經處理了。如果在 Dashboard 手動改過 visibility，要先手動發佈一次，之後 API 發佈才會生效。

**接到現有的 `.github/workflows/release.yml`**：在 build 出 `naruhodo.zip` 之後加三步：取得 token、`:upload`、`:publish`。建議用 `STAGED_PUBLISH`，審核通過後再到 Dashboard 手動發佈，配合 GitHub Release 的時間；Dashboard 的 deferred publishing 規則是審核通過後 30 天內要發佈，否則會退回草稿。

> 後來的做法：上傳獨立成 `.github/workflows/webstore.yml`，把既有 GitHub Release 的 `naruhodo.zip` 送審，可以手動觸發，release workflow 勾選時也會呼叫（預設不勾）。送審時機已經由人決定，所以維持 `DEFAULT_PUBLISH`。

出處：
- https://developer.chrome.com/docs/webstore/using-api
- https://developer.chrome.com/docs/webstore/service-accounts
- https://developer.chrome.com/docs/webstore/api/reference/rest
- https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
- https://developer.chrome.com/docs/webstore/api/v1
- https://developer.chrome.com/docs/webstore/publish
- https://developers.google.com/identity/protocols/oauth2

## 9. 審核時間與常見退件原因

**時間**：「For most extensions, review is completed within a few days, but it can take up to a few weeks.」超過三週還在 pending 可以聯絡支援。新開發者、新項目、危險權限、大幅改版都可能拉長時間。被退件時會收到 email，裡面寫明違反的政策與申訴方式；既有的 listing 不受影響，也不會通知使用者。申訴可以從項目頁的 Appeal 按鈕或 One Stop Support 提出。

**跟本外掛相關的退件代碼與預防：**

| 代碼 | 內容 | 本外掛的風險與預防 |
|---|---|---|
| Purple Nickel | 沒有 prominent disclosure，或在收集前沒有取得同意 | **最高風險**。2026-08 起的新規則下，目前 side panel 沒有揭露與同意畫面。做第 3.2 節的同意卡片 |
| Purple Lithium | 隱私權政策缺漏、失效、放錯欄位，或沒寫到資料處理 | 準備隱私權政策頁面（例如 GitHub Pages），填在 Dashboard 的專用欄位，內容要跟 Privacy 分頁一致 |
| Yellow Magnesium | 功能不能用，或套件壞掉 | 審查員沒有 Anthropic key 就看不到翻譯。在 Test instructions 提供一把設好低花費上限的測試 key 與操作步驟，並說明第一次要下載模型（約 128／472 MB）。官方寫 Test instructions 用於「restricted credentials or a paid account」的情境，BYOK 正好符合。沒有 key 時 UI 要有清楚的錯誤訊息（官方建議要說明需要帳號，並妥善處理 timeout 與 4xx／5xx） |
| Yellow Argon | 關鍵字堆砌：無實質價值的網站、品牌清單，同一個關鍵字重複超過 5 次 | description 不要列一長串支援的網站名稱，最多在功能描述裡自然提一兩個測試過的網站 |
| Red Nickel／Potassium／Silicon | 行為跟描述不符，或暗示有官方背書 | description 明寫需要自備 Anthropic API key、費用由使用者付給 Anthropic、第一次要下載模型。不要用出版社或網站的 logo |
| Purple Potassium | 申請了沒用到或過多的權限 | 六個權限都有實際用途。`storage` 只用在 Page Mode，justification 要寫清楚 |
| Yellow Zinc | 缺 icon、標題、截圖或描述，或內容沒有意義 | 照第 5 題準備 |
| Red Titanium | 程式碼混淆 | minified 的 ORT bundle 屬於允許的一般 minify。不要用 Base64 夾帶程式碼 |
| Blue Argon | MV3 的 remote code | 見第 1 題。確認 ORT 不會退回去 CDN 載 wasm |

出處：
- https://developer.chrome.com/docs/webstore/review-process
- https://developer.chrome.com/docs/webstore/troubleshooting
- https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- https://developer.chrome.com/docs/webstore/best-listing

---

## 出處

- Deal with remote hosted code violations — https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- Additional Requirements for Manifest V3 — https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- Extensions and AI — https://developer.chrome.com/docs/extensions/ai
- Manifest: content_security_policy — https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- Manifest: web_accessible_resources — https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
- What's happening in Chrome Extensions, January 2025 — https://developer.chrome.com/blog/extension-news-january-2025
- Manifest: description — https://developer.chrome.com/docs/extensions/reference/manifest/description
- Permissions list — https://developer.chrome.com/docs/extensions/reference/permissions-list
- Declare permissions and warn users — https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
- activeTab — https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- chrome.tabs — https://developer.chrome.com/docs/extensions/reference/api/tabs
- chrome.sidePanel — https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- chrome.offscreen — https://developer.chrome.com/docs/extensions/reference/api/offscreen
- chrome.storage — https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome Web Store Program Policies — https://developer.chrome.com/docs/webstore/program-policies/policies
- User Data FAQ（Updated Privacy Policy & Secure Handling Requirements）— https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Disclosure Requirements — https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements
- Limited Use — https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Handling Requirements — https://developer.chrome.com/docs/webstore/program-policies/data-handling
- Quality Guidelines（single purpose）— https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines
- Listing Requirements（keyword spam）— https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- Chrome Web Store policy updates（2026-07-01 公告）— https://developer.chrome.com/blog/cws-policy-updates-2026
- Fill out the privacy fields — https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Store listing tab — https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Test instructions tab — https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- Supplying images — https://developer.chrome.com/docs/webstore/images
- Creating a great listing page — https://developer.chrome.com/docs/webstore/best-listing
- Publish in the Chrome Web Store — https://developer.chrome.com/docs/webstore/publish
- Review process — https://developer.chrome.com/docs/webstore/review-process
- Troubleshooting Chrome Web Store violations — https://developer.chrome.com/docs/webstore/troubleshooting
- Trader/Non-Trader developer identification and verification — https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure
- Trader FAQ — https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq
- Register your developer account — https://developer.chrome.com/docs/webstore/register
- Publishers and members — https://developer.chrome.com/docs/webstore/group-publishers
- Empower your team with expanded roles（2026-04-28）— https://developer.chrome.com/blog/cws-role-expansion-developer-dashboard
- Developer Agreement — https://developer.chrome.com/docs/webstore/program-policies/terms
- Use the Chrome Web Store API — https://developer.chrome.com/docs/webstore/using-api
- Use a service account with the Chrome Web Store API — https://developer.chrome.com/docs/webstore/service-accounts
- Chrome Web Store API v2 REST reference — https://developer.chrome.com/docs/webstore/api/reference/rest
- publishers.items.publish — https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish
- Chrome Web Store API V1（deprecated）— https://developer.chrome.com/docs/webstore/api/v1
- Google OAuth 2.0（refresh token 在 Testing 狀態 7 天過期）— https://developers.google.com/identity/protocols/oauth2
