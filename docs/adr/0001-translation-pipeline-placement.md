# 翻譯流水線全部在外掛裡跑，LLM 只負責翻譯

v1 的流水線（擷取 → 切單頁 → 偵測 Balloon / Loose Text → OCR → 閱讀順序 → 讀音 → 翻譯 → 原地覆蓋）除了「翻譯」交給 LLM API 之外，全部在 Chrome 外掛裡執行，不需要本機 server。原因有三個：native host 已經排除（[#8](https://github.com/yurenju/naruhodo-manga-translator/issues/8)），本機 server 只能靠使用者手動啟動；WebGPU 上的本機 OCR 在 Windows 與 Mac 上都只要數秒（[#7](https://github.com/yurenju/naruhodo-manga-translator/issues/7)）；在真實頁面上，本機 detector 的 Balloon 框比看圖模型可靠（[#13](https://github.com/yurenju/naruhodo-manga-translator/issues/13)）。

## 各段放在哪裡

| 段落 | 位置 | 說明 |
| --- | --- | --- |
| 擷取 | service worker（`captureVisibleTab`）＋ content script（量 Page rect） | |
| 切單頁 | offscreen document | 一律先切成單頁；網站差異留給 adapter |
| 偵測 Balloon / Loose Text、OCR | offscreen document，WebGPU，退回 wasm | 模型常駐在 offscreen document，閒置一段時間後釋放 |
| 閱讀順序 | offscreen document，確定性程式碼（flood fill 找 Panel＋XY-cut） | LLM 不改動順序 |
| 讀音 | offscreen document，kuromoji | 確定性程式碼，有沒有 API key 都一樣 |
| 翻譯 | offscreen document 呼叫 LLM API | 每個 Page 一次呼叫，用 structured output 回傳 `{id, 譯文, unreadable, sfx}`；Series Notes 放在 system prompt＋cache。（[ADR 0005](0005-translation-and-notes-in-separate-calls.md)：翻譯另帶 Prior Pages，Series Notes 改由背景的第二次呼叫維護） |
| 原地覆蓋 | content script | 座標一律來自本機 detector，LLM 只透過 id 對應 |
| 顯示 | side panel | 只負責顯示，不參與執行（side panel 關掉時仍可預翻） |

## 不直覺的地方

- **LLM 永遠不提供座標。** 看圖模型的框在真實頁面上約有 8% 完全放錯。
- **讀音一律用 kuromoji，不跟 LLM 要。** 原本讓翻譯呼叫順手回讀音，以為比 kuromoji 準；實測（[#195](https://github.com/yurenju/naruhodo-manga-translator/issues/195)，361 句有漢字或數字的句子盲判）正好相反：翻譯呼叫關了 thinking 又要同時翻譯，回的讀音常留著漢字、換成同義詞或寫進別句的內容，錯誤率 18.6%，kuromoji 是 11.9%。讀音佔翻譯 output 約三分之一，拿掉後右頁譯文從 4.4 s 提早到 3.6 s、左頁從約 8 s 到 6.1 s，費用也少約 9%。最準的是把讀音併進背景的 Notes 呼叫（錯誤率 1.4%），但費用 +48%、讀音比譯文晚約 9 s 才換上，Notes 呼叫也變成同時做兩件事（[ADR 0005](0005-translation-and-notes-in-separate-calls.md) 當初就是為了這個把它們拆開），所以不做。kuromoji 剩下的錯大多是多音字與助數詞的音便（3分、一本、一人）。讀音全是推測，逐字稿不另外標示（原本標「讀音為推測」，每句都標等於沒標，已拿掉）。改版之前翻的快取，譯文照用，讀音在命中時換成 kuromoji 的，新舊頁行為一致。
- **LLM 只收文字，不收圖片。** 不做「高品質模式」（Sonnet 看圖每頁約 $0.0135，比 Haiku 文字模式貴約 45 倍）。代價是大型描邊狀聲詞會漏抓，這在 v1 是可以接受的。
- **OCR 亂碼由 LLM 標記。** 被標成 `unreadable` 的 Balloon 不做覆蓋，保留原圖，並在 side panel 標成「無法辨識」。
- **Loose Text** 走同一條流水線、同一次翻譯呼叫，但只顯示在 side panel，不做原地覆蓋。
