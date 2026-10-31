# 「完整可見」的 Page 要落在 viewport 與每一個會裁切的祖先裡面

[ADR 0003](0003-page-location-and-activation.md) 定位 Page 的方法是「可視區域裡夠大的 `<img>` / `<canvas>`」。翻頁式的 viewer（mock site 的 `?mode=paged`、真實網站的翻頁模式）把每一頁都放在同一個 `overflow: hidden` 的容器裡，用 `transform` 左右移動；隔壁頁的 `getBoundingClientRect()` 常常整個落在 viewport 裡，但被容器裁掉、畫面上看不到。只看 viewport 的話，隔壁頁會被當成 Page 截圖、跑 OCR、翻譯，覆蓋層也會蓋在看不到的元素上（[#34](https://github.com/yurenju/naruhodo-manga-translator/issues/34)）。

## 決定

Page 候選要**完整可見**：rect 落在 viewport 裡，**而且**落在每一個 `overflow-x` 或 `overflow-y` 不是 `visible` 的祖先（到 `<body>` 為止，不含 `<html>`／`<body>`）的 rect 裡，各邊容許 `VIEWPORT_TOLERANCE`（4 CSS px）。content script 量出這些祖先的 rect（`clipRects`），判斷本身（`isPageCandidate`）只吃 rect，維持可以單元測試。

## 不直覺的地方

- **捲動容器也算裁切。** `overflow: auto / scroll` 的容器裡捲到一半、被切掉一截的 Page 不算候選，等捲到完整可見才擷取；這跟 viewport 的規則一致（只翻完整看得到的頁）。
- **只看 overflow，不看其他裁切方式。** `clip-path`、`mask`、`contain: paint` 都沒有處理；遇到用這些方式藏起隔壁頁的網站再說。被其他元素蓋住不影響是不是候選，截圖前另外處理（下一節）。
- **每次量測都要對每個候選往上走一遍祖先、讀 `getComputedStyle`。** 候選只有畫面上夠大的 img／canvas，數量很少，v1 接受這個成本。
- **同步量測。** `IntersectionObserver` 也會扣掉祖先的裁切，但它是非同步回報；`scan.ts` 在截圖前後各量一次、不同就重試，需要當下就拿到結果，所以直接量 rect。

## 被其他元素蓋住：截圖前藏起來（#55、#59）

有的電子書閱讀器把工具列（書名列、試讀橫幅、進度列、翻頁箭頭）疊在整個 viewport 大小的 img 上面；截到的 Page 會帶著 UI，Balloon 被蓋掉一截，OCR 缺字，hash 也對不上（[#55](https://github.com/yurenju/naruhodo-manga-translator/issues/55)）。#55 原本的做法是「被有畫東西的元素蓋住就不截，side panel 提示使用者收起」，但在真實網站上誤判：翻頁感應區是透明、各蓋半個畫面的 `<a>`，只有貼在畫面邊緣的小箭頭背景圖，整塊被當成遮擋物，整頁都不翻（[#59](https://github.com/yurenju/naruhodo-manga-translator/issues/59)）。

所以改成**一律截圖，截圖前把疊在 Page 上的元素暫時藏起來**：content script 在每個 anchor 的 rect 內格點取樣 `elementsFromPoint`，hit test 堆疊裡排在 anchor 前面的元素就是遮擋物（`occlusion.ts`），用 `document.adoptedStyleSheets` 加一張樣式表把它們設成 `opacity: 0 !important; transition: none !important`，等重繪完才截，截完立刻拿掉（`capture.ts`）。真實網站上量到：canvas 型網站漫畫範圍內跟原圖 0 個像素不同；電子書閱讀器工具列開著時藏起來截的圖跟使用者手動收起後截的 0 個像素不同；找遮擋物＋套樣式 3～9 ms，不產生 mutation。

- **不判斷「有沒有畫東西」。** 以整個元素為單位判斷會被大塊透明、只畫一角的元素騙；排在前面的全藏掉，透明的藏了也看不出差別。
- **取樣時讓所有元素都接受點擊測試**（`* { pointer-events: auto !important }`）。電子書閱讀器的 img、浮水印、遮罩常是 `pointer-events: none`，`elementsFromPoint` 會跳過它們，就分不出誰在誰上面，浮水印會被截進去。同步加上、量完立刻拿掉，瀏覽器沒機會拿它算 hover。
- **不能加 attribute 或改 `style`**：會產生 mutation，觸發自己的翻頁偵測、變成無窮迴圈。所以樣式表用結構路徑 selector（`:root > body:nth-child(2) > … > a:nth-child(1)`）；截完再用同一組 selector 確認選到的還是同一批元素，不是的話（藏著的期間頁面換了元素）丟掉這張截圖重截，跟「截圖前後量到的版面不同就重試」同一個機制。
- **有些元素不藏**：包含 anchor 的祖先；自己的覆蓋層（另外照原本方式藏，已記下「帶覆蓋層的樣子」時不藏，但網站的遮擋物照樣藏）；`img`／`canvas`／`video`，可能是漫畫本身（有的電子書閱讀器 DOM 裡左右兩側各有一張預載的頁面 img）。包含其他 Page 候選的容器不藏本身，往下改藏它的子元素。藏不掉的就照截，不等待。
- **截圖期間遮擋物會消失一下**（真實 Chrome 截一次 1～2 秒）。電子書閱讀器的工具列會閃一下；比起整頁不翻，接受這個代價。
- **比取樣間距小的遮擋物可能漏掉；截圖期間才出現的也藏不到**（例如正在淡入的工具列）：截完只確認原本那批元素還在。v1 接受這個取捨。
- **不採用的做法**：直接讀 img／canvas 的像素（canvas 常是 tainted）、fetch 原圖（有的網站把圖切碎重排）、Element Capture、`chrome.debugger`：要每個網站專屬程式，或體驗很差。

## 比可見範圍高的 Page：跟著捲動辨識，用固定橫條認身分（#127）

直式捲動（縦読み）的作品裡，每個 Page 都可能比可見範圍高：第一輪盤點看到的作品每頁是顯示成 800×1775–1946 的 canvas，捲動容器只有 731 高，所以「完整可見」永遠不成立，整話一頁都不翻（[#121](https://github.com/yurenju/naruhodo-manga-translator/issues/121)）。canvas 是 tainted、讀不到像素，`captureVisibleTab` 又只截得到可見範圍，所以整張 Page 一次都拿不到。

**哪些候選走這條路**：高度超過可見範圍（viewport 與每個裁切祖先的交集）、寬度完整放得下的 img／canvas。其他候選照上面「完整可見」的規則，一點都不改，翻頁式 viewer 藏在裁切範圍外的隔壁頁照樣擋得掉。判斷只看幾何，所以使用者把翻頁 viewer 放大到比視窗高、或網站把整話做成一張長圖時，也會走這條路。這種 Page 還是一個 Page（GLOSSARY）：計費、Prior Pages、側欄都以整張圖為單位。

- **辨識跟著讀者的捲動走。** 每次捲動停下（沿用翻頁訊號的 debounce），就處理 Page 目前看得到的那一截：偵測與 OCR 的結果換算成 Page 座標存起來。被可見範圍邊緣切到的框先不收，等捲到它完整出現時再收；跟已收的 Line 在 Page 座標上重疊的框不重做。讀者要讀一句話，那句話一定曾經在某次停下時完整出現在畫面上，所以只要框不比可見範圍高，就一定收得到。
- **新收的 Line 馬上翻譯**，同一個 Page 已翻好的 Line 一起送當上下文。等整個 Page 收齊才翻的話，譯文會在讀者讀完上半部之後才出現。
- **Page 的身分用固定橫條的 hash 當指紋。** 橫條依 Page 寬度的比例切（高＝寬度的 1/4），每次截圖時完整可見的橫條各算一個 hash，記成「(第幾條, hash)」；快取存整個 Page 的 Line，任何一條對得上就認出是同一個 Page。只用有內容的橫條：全白或純背景的橫條會互撞，跟上面接受的「全白頁可能互撞」是同一類取捨。
- **截長 Page 時不藏自己的覆蓋層。** 每次捲動停下截到的範圍都不同，「記住帶覆蓋層的樣子」用不上；照原本每次都藏的話，讀者每停一次，翻好的中文就閃回日文一次。所以不藏，偵測結果裡跟已收 Line 重疊的框（偵測到的是我們蓋上去的中文）一律丟掉。橫條指紋只在這個 anchor 還沒認出是哪個 Page 時才比對，那時上面還沒有覆蓋層。

不直覺的地方：

- **不用固定分段。** 曾考慮把 Page 切成固定、互相重疊的段，每段完整可見時截，段的 hash 當身分。但要保證每個字都完整落在某一段，重疊量就得大於最高的那欄字；同一部作品框外的直排大字一欄約 400 px，可見範圍才 731，一張 canvas 要切 6 段以上，遇到更高的字還是會漏。所以辨識和身分分開：辨識跟著讀者，身分用不受視窗大小影響的固定橫條。
- **不自己捲動去拼整張。** 外掛替讀者捲過去截完再捲回來，畫面會跳，而且截圖限速每秒 2 次，很慢。
- **接續的翻譯請求不重複扣頁。** 一個長 Page 會分好幾次送翻譯，但 Translated Page 是一個 Page。同一個 Page 後面的請求帶上第一次回應的 `usageRecordId`，Worker 確認是這個 Account 的翻譯紀錄、在 1 小時內、接續次數沒超過上限（10 次），就只記用量不扣頁，超過上限當成新的一頁。改過的外掛可以把不同頁偽裝成接續，最多 11 頁付 1 頁，損失有上限，成本也照樣記在用量紀錄裡；整話一張長圖的網站也因為這個上限不會整話只扣一頁。
- **不處理的情況**：單一個框比可見範圍還高（任何捲動位置都看不完整），以及字剛好被兩個 Page 的交界切開（直式捲動網站的 canvas 切點是隨意的）。前者記 trace；後者要把相鄰 Page 接起來辨識，身分會複雜很多，等真實網站上看到漏得多再處理。新的框有一部分被舊的覆蓋層壓到時，會被當成重疊丟掉，也接受。
