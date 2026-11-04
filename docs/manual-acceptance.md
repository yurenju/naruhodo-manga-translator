# 真實網站手動驗收清單（#40）

在兩種真實網站上各走一次：**canvas 網站**（每頁一個 canvas 的漫畫網站）與**電子書閱讀器**（寬視窗時把跨頁合成一張 img）。這是唯一會走到真正 `activeTab` 授權路徑（點工具列圖示）的驗收；e2e 的 mock site 測不到。用語見 `GLOSSARY.md`，spec 見 #27 第 9、12 節。

## 分工

- **使用者**：開 `npm run debug:chrome` 錄 trace，照下面每一項操作，把「使用者回報」的項目記下來（通過／不通過＋一句話）。做完通知 Claude，並告訴它各段落大約是哪個時間做的。
- **Claude**：從錄到的 session（`%LOCALAPPDATA%\naruhodo\debug\<session>\trace.jsonl`）與 `npm run debug:eval` 核對標「trace」或「eval」的項目。讀法見 `docs/agents/real-site-debugging.md`。

每一項的「判斷」欄標註來源：

- **trace**：`npm run debug:summary -- --grep <event>` 或 trace.jsonl 的整行記錄。事件名稱與欄位都在 `grep -rn "trace('" src` 的呼叫處。
- **eval**：`npm run debug:eval -- <sw|content|page> -e "<expression>"`。外掛的 IndexedDB（`naruhodo`，store 名見 `src/shared/db.ts`）從 `sw` 讀。
- **使用者回報**：只能用肉眼判斷的項目。

## 準備

1. Terminal panel 開 `npm run debug:chrome`（第一次要在那個 Chrome 載入 `%LOCALAPPDATA%\naruhodo\extension`、在 side panel 設 API key、登入網站）。
2. 每個網站開始前：重新整理漫畫 tab。中途用 `npm run debug:reload` 改過 code，就要重新整理 tab 再點一次圖示。
3. 準備兩部作品各一話：canvas 網站一話（直向捲動或翻頁皆可）、電子書閱讀器一本有跨頁的書（試閱本即可）。各自都要能讀到至少 6 個 Page。
4. 第一次驗收建議清空舊資料（side panel 的快取／Notes），讓「第一次翻譯 → 快取命中」的對照乾淨。要保留就先匯出備份。

**不保存、不 commit 任何真實頁面的截圖或內容。** 截圖只留在 `%LOCALAPPDATA%` 的 session 資料夾，驗收結束、問題都處理完後刪掉。回報給 Claude 的截圖也不要放進 repo。

## 清單

以下 A–L 兩個網站都要走；開頭標「電子書閱讀器：」或「canvas 網站：」的項目只在那個網站走。

### A. 點圖示啟動

| # | 使用者操作 | 判斷 |
|---|---|---|
| A1 | 在漫畫 tab 點工具列圖示 | trace：出現 `status`（`active: true`）、`scan`，接著 `candidates`。使用者回報：side panel 自動打開 |
| A2 | 啟動前先捲動、翻幾頁再點圖示 | trace：點圖示之前沒有任何 `ctx: content` 的記錄（content script 只在點圖示後才注入） |
| A3 | 已啟動時再點一次圖示（#185：圖示是開關） | trace：`status` 是 `active: false`；畫面上的覆蓋層與 Page 上的狀態都消失、圖示沒有 badge，側邊欄開著的話一起關掉 |
| A4 | 在沒有漫畫的普通網頁點圖示 | trace：`scan:noCandidates`；沒有 `console-error`／`exception`。使用者回報：side panel 顯示沒有 Page，不當掉 |
| A5 | 啟動中重新整理 tab，**不點圖示**，等 10 秒 | 記錄結果即可：同 origin 會重新注入、繼續啟動（`src/background/index.ts` 的 `tabs.onUpdated`），但 Chrome 換頁時會收回 `activeTab`。trace：看有沒有新的 `capture`，或 `console-warn`／`console-error` 出現截圖失敗。使用者回報：有沒有繼續翻譯 |
| A6 | 看工具列上的外掛圖示（釘選出來），Chrome 外觀分別切淺色與深色主題各看一次；再打開 side panel | 使用者回報：16px icon（藍色對話框裡白色「な」）在淺色與深色工具列上都認得出來；side panel 標題是 logo＋「Naruhodo」 |

### B. 截圖與 Page 定位

| # | 使用者操作 | 判斷 |
|---|---|---|
| B1 | 啟動後停在一頁不動 | trace：`candidates` 列出的候選數＝畫面上完整可見的 Page 數；`rejected`／`small` 裡沒有應該是 Page 的元素（看 `rect` 與 viewport） |
| B2 | 同上 | trace：`capture` 的 `ms`（真實 Chrome 約 0.25 s，#60）；`capture` 的截圖（images/）裡看不到我們的譯文 |
| B3 | 同上 | trace：`crop` 的每個 Page 縮圖（images/）各是一整頁，沒切到別頁、沒多切黑邊或網站 UI |
| B4 | 同上 | trace：`analyze` 的 `detections` 疊圖：藍框（Balloon）有框到對話框、數字是由右到左、由上到下的閱讀順序 |
| B5 | 捲動到兩頁各露一半的位置停住 | trace：只露一半的 Page 不在 `candidates`，或在 `rejected` 裡有理由；沒有翻譯不完整的 Page |
| B6 | 截圖期間一直捲動 | trace：允許 `scan:layoutChanged` 重試；最後的 `crop` 跟最後的畫面一致，沒有 `overlay:skip` 以外的錯誤 |

### C. Spread（跨頁）

| # | 使用者操作 | 判斷 |
|---|---|---|
| C1 | 電子書閱讀器：視窗橫長，顯示跨頁 | trace：一個 `candidates` 候選切成兩個 `crop` Page（同一個 `anchorId`，各有 `subRect`），兩頁的 `pageHash` 不同 |
| C2 | 同上 | trace：job 佇列先右頁後左頁：`job` 的 `enqueue`／`start`／`llm` 依序是右頁 `pageHash` 再左頁 |
| C3 | 電子書閱讀器：封面或章節首頁（跨頁模式只顯示一頁） | trace：只切出一個 Page，沒切出空白頁（看 `crop` 縮圖） |
| C4 | 電子書閱讀器：深色或滿版出血的頁面 | trace：`crop` 縮圖沒有把頁面本身的深色邊當黑邊切掉 |
| C5 | canvas 網站：一般閱讀 | trace：每個 Page 都是整個 anchor，`crop` 沒有 `subRect`（canvas 網站不用切） |
| C6 | 跨頁兩頁都翻完 | 使用者回報：兩頁的覆蓋層各自落在自己那一頁，中縫附近沒有錯位 |

### D. 翻頁自動翻譯

| # | 使用者操作 | 判斷 |
|---|---|---|
| D1 | 連續往後翻 6 頁以上，每頁停到譯文出現 | trace：每次翻頁都有 `pageTurn`（看 `reasons`）→ `scan` → `capture` → `crop`；每個新 Page 有 `cache:miss` → `analyze:done` → `translate:done` → `overlay:show` |
| D2 | 快速連翻 3 頁再停下 | trace：翻走的 Page 在 `job` 裡是 `drop`（沒開始就丟掉）或做完但不顯示，最後停下的頁優先 `start` |
| D3 | 連續快速觸發（例如一直捲動） | trace：`capture` 記錄的 `at` 間隔，每秒不超過 2 次 |
| D4 | 全程 | trace：沒有 `analyze:error`、`translate:error`（有就記下 `error`）；沒有 `console-error`、`exception` |
| D5 | 全程 | trace：`translate:done` 的 `ms`、`usage`；Claude 整理平均每頁秒數與 token 用量 |

### E. 覆蓋位置與字級

| # | 使用者操作 | 判斷 |
|---|---|---|
| E1 | canvas 網站預設縮放閱讀 | trace：`overlay:show` 的 `screenScale` 約 0.49（canvas 764×1200 縮在畫面上的比例，依網站而定） |
| E2 | 同上 | trace：`overlay:show` 的 `fits` 裡沒有 truncated、`skipped` 裡沒有不該跳過的 Balloon |
| E3 | 看 3 頁以上 | **使用者回報**：譯文都落在對應的 Balloon 內、沒有蓋到別的 Balloon 或圖 |
| E4 | 同上 | **使用者回報**：字級讀得清楚、在同一頁裡大小一致；直排／橫排符合原本的方向 |
| E5 | 電子書閱讀器跨頁與單頁各看一次 | **使用者回報**：同 E3、E4 |
| E6 | 滑鼠移到譯文上 | **使用者回報**：tooltip 與 highlight 出現在滑鼠指的那句，side panel 對應的 Line 同步標示 |
| E7 | 在 canvas 網站用網站自己的放大功能 | trace：`overlay:show` 重新排版（新的 `screenScale`）或 `overlay:reattach`。使用者回報：放大後位置仍對 |
| E8 | 滑鼠移到有振り仮名的那句，再看 side panel 的逐字稿 | **使用者回報**（design tokens，#71）：tooltip 是深色底、ルビ淺朱色；side panel 的ルビ是朱色、按鈕與選取是墨色、逐字稿選取列左側是黃色指示線（#187），兩邊看起來是同一個產品；網站的 CSS 沒有把 tooltip 的顏色或字型蓋掉 |

### F. 快取

| # | 使用者操作 | 判斷 |
|---|---|---|
| F1 | D 翻過的頁往回翻 | trace：回到已翻過的 Page 是 `cache:hit`（或同一個 tab 內直接認得、沒有新的 `analyze`），沒有新的 `translate:request` |
| F2 | 重新整理 tab、再點圖示、回到同一頁 | trace：`cache:hit`，`cachedHash` 與這次 `pageHash` 接近（同一頁）。使用者回報：狀態列顯示「快取」 |
| F3 | 電子書閱讀器：同一跨頁，換 3 種視窗大小（橫長、更寬、直式單頁），每次停到譯文出現 | trace：每種大小切出的 Page 都 `cache:hit`；`crop` 的 `pageHash` 跟第一次相近（#35 量測：同頁距離 ≤ 4，不同頁 ≥ 98） |
| F4 | 同上 | **使用者回報**：換視窗大小後覆蓋層位置仍對（快取的座標是相對 Page 的比例） |
| F5 | canvas 網站：換視窗大小 | trace：`cache:hit`（canvas 固定大小時距離應該是 0） |
| F6 | 全程 | trace：沒有 `cache:noSeries`（有就代表那次啟動沒有 Series） |

### G. Series 預選

| # | 使用者操作 | 判斷 |
|---|---|---|
| G1 | 新作品第一次啟動 | trace：`series:forUrl` 是 `preselected: false`（新建 Provisional Series），`activate` 與之後 `cache:*` 的 `seriesId` 就是它 |
| G2 | side panel 把它命名（或選既有的 Series） | trace：`panel:renameSeries`（或 `panel:selectSeries`／`panel:createSeries`）之後有 `series:remember`，`pattern` 是這個網址的 origin＋path、`seriesId` 是該 Series |
| G3 | 關掉這個 tab，開新 tab 到同一話的網址，點圖示（同一個 tab 重新整理會沿用原本的 Series，測不到預選） | trace：`series:forUrl` 是 `preselected: true`、`seriesId` 是 G2 的 Series（預選成功）。使用者回報：side panel 已選好那個 Series |
| G4 | 同一作品下一話（不同網址）啟動 | 記錄結果即可：網址模式只認 origin＋path，下一話不同 path 時會是新的 Provisional Series，要在 side panel 選或合併 |
| G5 | 把 G4 的 Provisional Series 合併進 G2 的 Series | trace：`series:merge`（`sourceId`＝Provisional Series、`targetId`＝G2 的 Series，帶搬過去的快取／Notes 筆數）與 `panel:mergeSeries`（`from`→`seriesId`）；沒有 `series:merge` 就是沒合併（來源不是 Provisional Series） |

### H. Series Notes

| # | 使用者操作 | 判斷 |
|---|---|---|
| H1 | 翻 6 頁以上有角色名的頁面 | trace：`translate:request` 的 `input.seriesNotes` 隨頁數累積、`input.priorPages` 帶前面看過的頁；背景整理 Notes 的 `notes:response` 的 `output.notes_changes` 有新增條目 |
| H2 | 同上 | trace：`notes:apply` 的 `added` 是實際採用的新條目；`rejected` 是原文不在那頁任何 Balloon（`analyze` 的 `balloons[].原文`）而沒採用的 |
| H3 | 跨頁的兩頁 | trace：同一個 Spread 的兩頁 `notes:request` 帶的 `seriesNotes` 相同（同一份快照）；左頁的 `notes:apply` 對右頁剛新增的條目給不同譯名時出現在 `dropped`，不出現在 `suggestions` |
| H4 | 在 side panel 修改一個條目的譯文 | trace：`panel:editNote`（`原文`、`fields`；改過的條目一律 locked）。使用者回報：條目顯示 🔒 |
| H5 | 繼續翻到用到那個條目的頁 | trace：之後的 `translate:request` 帶的是改過的譯文；那頁的 `notes:apply` 裡這個原文不在 `added`／`filled`，LLM 想改的話只出現在 `suggestions` |
| H6 | 有建議修改時，在 side panel 接受一個、忽略一個 | trace：`panel:acceptSuggestion`、`panel:ignoreSuggestion` 各一筆（`原文`、`建議譯文`）。使用者回報：兩個建議都從 side panel 消失 |
| H7 | H4 改過之後，回到之前用過那個條目的已翻譯頁 | trace：翻回來的頁 `cache:hit` 帶 `stale: "notes"`（還在畫面上的頁則是 `stale:changed`）；按「重新翻譯」之前沒有新的 `translate:request`。使用者回報：該頁提示過時 |
| H8 | 匯出 | trace：`panel:export` 的 `format` 是 `naruhodo-backup`、`counts` 有五個陣列的筆數、`hasApiKeyPrefix: false`（檔案內容找不到 key 的前綴 `sk-ant-`） |
| H9 | 改一個條目後匯入 H8 的檔案 | trace：`panel:import` 是 `ok: true`、`notesSeriesIds` 有這部 Series。eval：衝突的譯文變成建議修改（來源 `imported`）。使用者回報：side panel 顯示建議 |

匯出檔含真實頁面的原文與譯文，跟截圖一樣不要放進 repo，驗收完刪掉。

### I. 停止與還原

| # | 使用者操作 | 判斷 |
|---|---|---|
| I1 | 在 side panel 停止（或再按停止的方式） | trace：`status`（`active: false`），接著 `ctx: content` 的 `content:stop` 是 `overlaysLeft: 0` |
| I2 | 停止後翻頁 | trace：沒有新的 `pageTurn`／`scan`／`capture` |
| I3 | 同上 | **使用者回報**：頁面跟沒裝外掛時一樣，網站功能正常 |
| I4 | 啟動中換到別的 origin | trace：`status`（`active: false`） |

### J. 截圖閃爍

| # | 使用者操作 | 判斷 |
|---|---|---|
| J1 | 一般閱讀速度翻 10 頁以上 | trace：每次 `capture` 前後的 `overlay:restore` 的 `hiddenMs`；Claude 整理平均與最大值 |
| J2 | 同上 | **使用者回報**：覆蓋層在截圖時消失又出現，是否干擾閱讀（不干擾／可接受／干擾） |

### K. 覆蓋層重掛（網站重建 DOM）

| # | 使用者操作 | 判斷 |
|---|---|---|
| K1 | 正常閱讀全程 | trace：`overlay:detach`／`overlay:reattach`／`overlay:removeLayers` 的次數與 `reason`；`overlaid:mismatch` 的次數 |
| K2 | 有 `reattach` 的時間點 | **使用者回報**：覆蓋層沒有消失或殘留在錯的頁 |

### L. 結尾

| # | 使用者操作 | 判斷 |
|---|---|---|
| L1 | 全程 | trace：`npm run debug:summary` 的 event counts 沒有 `console-error`、`exception` |
| L2 | — | 發現的問題：小的直接修，大的另開 ticket，記在 #40 |

## 結果記錄

使用者每個網站填一份，貼回給 Claude：

```
網站：canvas 網站 / 電子書閱讀器
session：<YYYYMMDD-HHmmss>
時間段：A–B 約 hh:mm、D 約 hh:mm、……
使用者回報：
- A6：
- E3：
- E4：
- E5：
- E6：
- E7：
- F4：
- H7：
- I3：
- J2：
- K2：
其他觀察：
```
