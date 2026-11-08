# 用通用方法定位 Page、以影像 hash 辨識 Page，外掛只在使用者點圖示的 tab 上啟動

v1 沒有網站 adapter。Page 的定位、翻頁偵測、Page 的身分都用同一套通用方法，在第一批驗證的兩種閱讀網站（每頁一個 canvas 的漫畫網站、把整個 viewport 合成一張 img 的電子書閱讀器）上都能運作（[#18](https://github.com/yurenju/naruhodo-manga-translator/issues/18)）。兩種網站翻頁都不改 URL，也不一定有單一 Page 元素（[#5](https://github.com/yurenju/naruhodo-manga-translator/issues/5)），所以 Page 是用畫面上的影像來辨識，不靠網址或頁碼。外掛預設對任何網站都不動作，使用者對某個 tab 點外掛圖示（或按快捷鍵）時才啟動。

## 做法

- **定位 Page**：可視區域裡夠大的 `<img>` / `<canvas>`，每個元素是一個 Page 候選。「夠大」是寬至少 200 px，高至少 400 px 或可見高度的一半（滿足一個就算）：網站首頁、目錄頁的縮圖一次好幾十張，誤翻會大量花掉 Translated Pages，這條規則一次擋掉它們。跟 Page 一樣大的廣告頁（每話開頭、結尾一兩頁）擋不到；為了它加看內容的規則（Balloon 數、文字方向、出現過幾次）都會誤擋旁白頁或讓規則變複雜，所以接受這一兩頁的誤翻（「完整可見」也要在每個會裁切的祖先裡面，見 [ADR 0004](0004-fully-visible-page-inside-every-clipping-ancestor.md)；比可見範圍高的 Page 另有規則，見 ADR 0004 最後一節）。看起來是 Spread 的候選（寬 > 高）在 offscreen document 去暗色邊緣、找中縫，切成兩個 Page；寬 > 高卻切不開的候選這次不產生 Page（[#55](https://github.com/yurenju/naruhodo-manga-translator/issues/55)）。白邊不去：會連頁面本身的留白一起切掉，OCR 的輸入和 hash 都會變。有的網站每頁一個 canvas，有的電子書閱讀器把整個 viewport 合成一張 img。
- **偵測翻頁**：DOM mutation、scroll、resize、按鍵、點擊、img load 等訊號經過 debounce（約 300–500 ms）後截圖，再比對每個 Page 的縮圖 hash，hash 變了才算翻頁。不做定時輪詢。
- **Page 的身分**：快取 key 是 `(Series, Page 影像的 perceptual hash)`，比對時用 Hamming 距離門檻。同一個 Page 在不同網站讀，會命中同一筆快取。比可見範圍高的 Page 從沒被整張截過，改用固定橫條的 hash 當指紋（ADR 0004 最後一節），原則一樣是用影像認 Page。
- **覆蓋座標**：Balloon 框存成相對 Page 的 0～1 比例座標。每個 Page 記一個 anchor 元素，Spread 另外記 `subRect`（例如左半）。渲染時用 anchor 目前的 rect 換算成畫面座標。
- **啟動**：`action.onClicked`（或 `commands`）是開關（[#185](https://github.com/yurenju/naruhodo-manga-translator/issues/185)）。沒啟動時注入 content script 開始翻譯；Side Panel on Activation（全域設定，存在 `chrome.storage.local`）開著才在第一個 `await` 之前呼叫 `sidePanel.open()`。已啟動時再點一次就停止、移除覆蓋層，並用 `sidePanel.close()` 關掉 side panel（Chrome 141，`minimum_chrome_version` 因此是 141）。啟動狀態維持到 `activeTab` 授權結束（換 origin、關 tab）、再點一次圖示或使用者按 side panel 的「停止」為止。讀者按 × 關掉 side panel 不會停止，同 origin 重新整理後自動重新注入。記住的網址模式只用來預選 Series，不會自動啟動。圖示右鍵選單可以改這個設定，或臨時「打開側邊欄」。
- **狀態不只在 side panel**：翻譯中、模型下載中、出問題（沒登入、額度用完、翻譯失敗）也由 content script 蓋在 Page 的 anchor 上（`pointer-events: none`、不改網站版面，截圖時藏起來），圖示掛 badge。點圖示的當下就卡住（沒同意、沒登入、額度 0）時照常啟動，同時打開 onboarding 能解決問題的那一步；看到一半才出問題絕不自動開分頁，只在 Page 右上角顯示可以點的紅色小標籤。
- **權限**：只宣告 `activeTab` + `scripting` + `sidePanel`（#185 起加上圖示右鍵選單的 `contextMenus`，沒有安裝警告），沒有 `<all_urls>`，也沒有靜態 `content_scripts`。

## 不直覺的地方

- **SW 剛醒來時不知道 Side Panel on Activation。** `sidePanel.open()` 要在第一個 `await` 之前呼叫，設定卻要從 `chrome.storage` 非同步讀。SW 被點圖示喚醒時常常還沒讀到，所以 SW 把設定同步成全域 side panel 的 `enabled`（停止時這個 tab 的 `enabled` 也跟著設定）；還沒讀到時只呼叫 `open()`，由 Chrome 照 `enabled` 決定開不開。同理，剛醒來時也不知道這個 tab 已經啟動，點圖示停止時 side panel 可能先打開再關掉。

- **刻意不用 `sidePanel.setPanelBehavior({openPanelOnActionClick: true})`。** 用了以後點圖示**不會**給 `activeTab`，`captureVisibleTab` 就不能用（要 `activeTab` 或真的授予 `<all_urls>`）。從 Chrome 內建的 side panel 選單打開外掛也拿不到授權，這時 side panel 只會提示使用者點圖示。
- **不做「記住網站、自動翻譯」。** `captureVisibleTab` 不吃單一網站的 host permission，要自動啟動就必須要求 `<all_urls>`。v1 選擇不要求這個權限。
- **Page 的身分不是頁碼。** 沒有 adapter 就拿不到可靠的 Episode / 頁碼。影像 hash 是近似比對，全白或幾乎全黑的頁可能互撞，但這類頁通常沒有文字，翻錯的代價很小。之後如果改用網站提供的 id，就要重建快取。

## 先不做

網站 adapter：等遇到通用方法處理不了的網站再設計。可以覆寫的點會是「找 Page」、「翻頁偵測」、「Page key」，其他段落（擷取、偵測、OCR、翻譯）都不會交給 adapter。
