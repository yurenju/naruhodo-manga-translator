# Series Notes 由 LLM 維護、存在 IndexedDB，不是檔案

Series Notes 原本預期是一般檔案（Markdown），讓人和 Claude Code 都能直接讀寫。改用 LLM API 之後，Claude Code 不再參與（[#8](https://github.com/yurenju/naruhodo-manga-translator/issues/8)）；Notes 的用途也收斂成「讓整部 Series 的譯名與說話方式一致」。因此 Notes 改由 LLM 在翻譯時順手維護，人主要是看、偶爾修正；Notes 和每頁的翻譯快取都存在外掛的 IndexedDB（加 `unlimitedStorage`），不用本機資料夾（[#20](https://github.com/yurenju/naruhodo-manga-translator/issues/20)）。

## 決定

- **結構化條目，不是自由書寫的文件。** 每筆條目：`原文`、`讀音`、`譯文`、`類別`、`備註`、`locked`；人名另有 `自稱`、`語氣`、`稱呼`（[ADR 0005](0005-translation-and-notes-in-separate-calls.md) 起只由人填）。不記劇情進展（會無限變長）。
- ~~**在同一次翻譯呼叫裡更新。**~~ 已被 [ADR 0005](0005-translation-and-notes-in-separate-calls.md) 取代：Notes 改由背景的第二次呼叫維護。原本的做法是擴充 [ADR 0001](0001-translation-pipeline-placement.md) 的回傳格式：除了 `{id, 讀音, 譯文, unreadable}`，再回傳 `notes_changes`（這頁新出現的條目），不多花一次呼叫。
- **LLM 只能新增、不能改譯名。** LLM 可以新增條目或補空欄位；想改既有的 `譯文` 只能提「建議修改」，由人在 side panel 接受或忽略。人改過的條目設為 `locked`。修改由 service worker 依頁面順序逐筆套用，同一個 `原文` 先到先贏，後到的變成建議。既有條目的 `譯文` 是空的就直接補上，不算改譯名。合併 Provisional Series 時套用同一套規則；每筆建議記下來源是哪個 Page（`{ pageHash }`）或從哪部 Series 合併進來（`{ mergedFrom }`）。
- **人可以刪條目，也可以讓 LLM 不再記。** 刪除條目時，讀者可以選擇把它的 `原文` 變成 Excluded Term（不記的詞）。之後 LLM 的新增、合併 Provisional Series 與匯入，都不會把這個原文加回這部 Series，也不會為它產生建議修改。如果不選，LLM 下次遇到這個原文時可以重新記。刪除條目不會讓已經翻譯的頁變成過時。Excluded Term 跟條目一樣屬於 Series，合併、匯出／匯入都會一起帶走，讀者也可以恢復。
- **Series 身分是外掛產生的 ID。** 每個網站的網址模式對應到同一個 Series ID，所以同一部 Series 在不同網站共用一份 Notes。
- **翻譯快取只存文字與座標**（Balloon 座標／原文／讀音／譯文／`unreadable`、Loose Text、模型名、prompt 版本、翻譯時間），不存頁面圖片。key 是「Series ID ＋ Page 身分」（Page 身分見 [#18](https://github.com/yurenju/naruhodo-manga-translator/issues/18)）。
- **過時只提示、不自動重翻。** 只有「這頁原文用到的條目譯文被改了」或「模型／prompt 版本不同」才提示；新增條目不算。

## 不採用的做法

- **使用者選的本機資料夾（File System Access API）。** 唯一的好處是外部工具能直接讀寫，而這個需求已經不存在；代價是重開 Chrome 後可能要重新授權，而且只有 side panel 這類有畫面的頁面能要求權限。
- **整份 Markdown 讓 LLM 重寫。** LLM 每次重寫整份很容易刪掉或改掉舊內容，條目＋只能新增的規則比較安全。

## 後果

- 兩台電腦之間不自動同步，靠 side panel 匯出／匯入 JSON。
- 每次翻譯都送整份 Notes；Notes 變得太長時要另外決定篩選方式。
