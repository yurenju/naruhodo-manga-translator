/**
 * 截圖期間讓頁面持續重繪（#60）。真實 Chrome 的 captureVisibleTab 要等一張新的合成畫面，畫面靜止時
 * 要等到 timeout（canvas 網站約 1.6 s）；一直有東西在動就約 0.25 s。
 *
 * 動的是 `html::after` 左上角 1px、opacity 在 0 與 0.0001 之間：8-bit 截圖裡四捨五入後跟沒有它完全一樣
 * （真實的 canvas 網站與電子書閱讀器比對過整張截圖），Chrome 卻仍算它有變化。opacity 固定 0 只動 transform、或放在
 * viewport 外，都會被 Chrome 最佳化掉、截圖一樣慢。
 *
 * 同時用 `html::before` 畫 frame 記號（shared/frame-mark.ts）：截到的 frame 有它才是準備好之後的。
 *
 * 用 adopted stylesheet：不產生 mutation，不觸發自己的翻頁偵測。動畫是 infinite，拿掉時只會發
 * animationcancel；animationend 會被翻頁偵測當成翻頁（target 是包著 Page 的 html）。
 */
import { FRAME_MARK_SIZE, frameMarkBackground, type FrameMark } from '../shared/frame-mark.ts';

/** SW 沒送停止（例如 SW 在截圖中被停掉）時最多跑這麼久；真實 Chrome 一次截圖最多約 1.7 s。 */
const MAX_RUN_MS = 5000;

const REPAINT_CSS = `
@keyframes naruhodo-repaint { from { opacity: 0; } to { opacity: 0.0001; } }
html::after {
  content: '' !important; display: block !important; position: fixed !important; left: 0 !important; top: 0 !important;
  width: 1px !important; height: 1px !important; background: #000 !important; pointer-events: none !important;
  z-index: 2147483647 !important; animation: naruhodo-repaint 1s linear infinite alternate !important;
}
`;

const markCss = (mark: FrameMark) => `
html::before {
  content: '' !important; display: block !important; position: fixed !important; left: 0 !important; top: 0 !important;
  width: ${FRAME_MARK_SIZE.width}px !important; height: ${FRAME_MARK_SIZE.height}px !important; margin: 0 !important;
  background: ${frameMarkBackground(mark)} !important; opacity: 1 !important; transform: none !important; filter: none !important;
  pointer-events: none !important; z-index: 2147483647 !important;
}
`;

const sheets = new Map<FrameMark | 'repaint', CSSStyleSheet>();
const sheetOf = (key: FrameMark | 'repaint') => {
  let sheet = sheets.get(key);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(key === 'repaint' ? REPAINT_CSS : markCss(key));
    sheets.set(key, sheet);
  }
  return sheet;
};
let timer: ReturnType<typeof setTimeout> | undefined;

/** mark：這次截圖的 frame 記號；換 mark 時拿掉另一個。 */
export function startRepaint(mark: FrameMark): void {
  const own = new Set(sheets.values());
  document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter((s) => !own.has(s)), sheetOf('repaint'), sheetOf(mark)];
  clearTimeout(timer);
  timer = setTimeout(stopRepaint, MAX_RUN_MS);
}

export function stopRepaint(): void {
  clearTimeout(timer);
  timer = undefined;
  // 只拿掉自己的：網站可能在這段期間改過 adoptedStyleSheets
  const own = new Set(sheets.values());
  if (own.size > 0) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => !own.has(s));
}
