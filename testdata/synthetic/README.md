# 合成測試頁（Synthetic test Pages）

依照真實日文漫畫的樣式特徵製作的**原創**測試 Page，每張附 ground truth JSON，
讓 OCR / 翻譯實驗可以自動計算準確率（偵測、閱讀順序、原文、讀音、譯文）。

- 內容（台詞、角色、圖案）全部原創，只用簡單幾何圖形，不模仿任何既有作品或角色。
- 真實網站的漫畫頁面**不保存、不 commit**，只放這裡的合成頁。
- 用語遵循 repo 根目錄的 `GLOSSARY.md`（Page、Panel、Balloon…）。

## 檔案

```
specs/<id>.json   每張 Page 的宣告式描述（格、Balloon、台詞、讀音、譯文、閱讀順序）
template.js       在 headless Chrome 裡把 spec 畫成 SVG + HTML，並量測實際座標
render.mjs        批次渲染：specs/ → out/<id>.png + out/<id>.json
out/              產出（已 commit；這是實驗要用的正本）。spec 有 `"blank": true` 時另外輸出
                  out/<id>-blank.png：同一頁不畫字，當成「完美擦除」的正確答案
```

## 重新產生

```bash
cd testdata/synthetic
npm install
npm run render            # 全部
node render.mjs p02-ruby  # 只渲染指定 id
```

需要本機 Chrome（Windows / macOS 預設路徑會自動找，或設 `CHROME_PATH`）。
字型取決於系統（Windows 用 Yu Gothic，macOS 會落到 Hiragino 等），
所以不同機器重新渲染的像素會略有差異；**commit 的 `out/` 是正本**，
重新渲染後要一起更新 PNG 與 JSON，兩者的座標才會一致。

## spec 的文字標記

`ja` 欄位用簡單標記描述排版：

| 標記 | 意義 | 例 |
|---|---|---|
| `{漢字\|かな}` | 振り仮名（ルビ） | `{本気\|マジ}で` |
| `[12]` | 縦中横（直書中橫放的數字、`!?`） | `[4]月[12]日` |
| `\n` | Balloon 內的手動換行（直書時是換欄） | `うん、\nパンを` |

Balloon 的 `shape` 除了 ground truth 列的那些，還有 `gradient`（直向漸層底色，`gradient: [上, 下]`）
與 `flash`（閃光泡泡：沒有外框，白底由放射線圍起來）；ground truth 照樣記成這兩個值。

其他排版欄位：`outline: "white"`（黑字加白描邊，框外獨白壓在線條上的樣子）、`rotate`（旋轉）、`skewY`（斜切）、`skew`（斜體）、`rough: true`
（SVG 濾鏡讓筆畫抖動，模擬手寫狀聲詞；本機沒有日文手寫字型時的替代）。

## Ground truth 格式（`out/<id>.json`）

座標一律是 PNG 像素 `[x, y, width, height]`，原點在左上。

```jsonc
{
  "id": "p07-spread",
  "image": "p07-spread.png",
  "width": 1760, "height": 1280,
  "readingDirection": "rtl",
  // 單頁時只有一個；雙頁跨頁時 index 0 是右頁（先讀）
  "pages": [{ "index": 0, "bbox": [880, 0, 880, 1280] }, { "index": 1, "bbox": [0, 0, 880, 1280] }],
  "panels": [{ "id": "S", "page": null, "order": 1, "bbox": [...], "polygon": [[x, y], ...] }],
  "texts": [{                       // 依閱讀順序排序
    "id": "t3",
    "kind": "balloon",              // balloon | thought | narration | sfx | sign | outside
    "shape": "ellipse",             // ellipse | burst | thought | whisper | inverted | rect | none
    "panel": "B",                   // 所屬 Panel；橫跨兩格時取主要那格
    "page": 0,                      // 跨頁時跨越中縫的文字為 null
    "order": 3,                     // 全頁閱讀順序（1 起算）
    "orientation": "vertical",      // vertical | horizontal
    "rotate": 0,                    // 文字旋轉角度（狀聲詞常見）
    "bbox": [695, 420, 130, 240],   // Balloon 外框；無外框時同 textBbox
    "textBbox": [710, 496, 103, 88],// 實際文字（含ルビ）範圍
    "ja": "本気で言ってるのか!?",
    "jaLines": ["本気で", "言ってる", "のか!?"],
    "ruby": [{ "base": "本気", "rt": "マジ" }, { "base": "言", "rt": "い" }],
    "reading": "マジでいってるのか!?", // 整句讀音（假名），義訓以ルビ為準
    "zh": "你是認真的嗎!?"           // 參考譯文（zh-TW）
  }]
}
```

`kind` 的分類：

- `balloon`：對話 Balloon（含爆炸形、悄悄話、黑底白字）。
- `thought`：思考泡泡。
- `narration`：旁白（有框或無框）。
- `sfx`：狀聲詞。依 map 決定只在 side panel 顯示，不原地覆蓋。
- `sign`：畫在物件上的文字（招牌、手機畫面、站牌）。
- `outside`：Balloon 外的手寫小字、註記（`ハァ…`、`※閉店後`）。

## 各頁涵蓋的特徵

| id | 重點 |
|---|---|
| `p01-basic` | 5 格、直書橢圓 Balloon、標準右上→左下順序、一個旁白框、一個橫書小 Balloon |
| `p02-ruby` | 振り仮名：人名地名、義訓（本気→マジ、相棒→パートナー）、縦中横 `4月12日`、`!?` |
| `p03-shapes` | 爆炸形、思考泡泡、虛線悄悄話、黑底白字、旁白框、橫跨格線的 Balloon、網點背景 |
| `p04-outside` | 大型描邊狀聲詞（直／橫、旋轉）、小狀聲詞、招牌、手寫風小字、黑底白字、網點上的 Balloon |
| `p05-dense` | 斜切格線、右側縱長格（先讀長格再讀左邊上下格）、小字 17px、橫跨格間空白的 Balloon、極小註記 |
| `p06-horizontal` | 手機畫面訊息（橫書）、英數混排 `6:50`、`BUS STOP`、時間戳、直書與縦中横並存 |
| `p07-spread` | 雙頁跨頁（電子書閱讀器在寬視窗會把兩頁合成一張圖）、橫跨兩頁的大格、跨越中縫的狀聲詞 |
| `p08-action` | 戰鬥跨頁：整格招式名大字（無 Balloon、長片假名ルビ撐開漢字）、手寫風抖動狀聲詞、同字狀聲詞重複出現（ガタ／ゴト）、深色網點上的大狀聲詞、超出格線的狀聲詞。注意：真實手繪狀聲詞仍比這張難（#6 實測 Sonnet 在真實頁漏掉約一半狀聲詞，這張全抓到） |
| `p09-erase` | 擦除範圍與顏色（#149）：字撐滿的橢圓（文字框四角在泡泡外、灰底上）、連體泡泡、漸層泡泡、閃光泡泡、黑底白字；Loose Text 原地覆蓋（#151）：白描邊獨白壓在線條上、黑底白字、網點上的標題、彩色背景、一個小狀聲詞。另有無字的 `p09-erase-blank.png` |

解析度：單頁 880×1280，接近真實 canvas 型網站的原圖（822×1200）。實驗需要模擬
`captureVisibleTab` 的較低解析度時，請自行縮放圖片並等比例換算座標。
