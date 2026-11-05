/**
 * 譯文的標點用打包的 Noto Sans TC 字形（src/shared/punctuation-font.ts，約 4 KB）：系統字型的位置不對。
 * 微軟正黑體的「。，、」橫書在左下、直書在右上，「！？」直書靠右，破折號 ― 只有半格寬（橫書偏上、直書靠右），
 * 有的字型沒有 … 的直書字形；台灣的標點在格子中間。其餘的字照舊用系統字型（--naru-font-sans）。
 *
 * 覆蓋層的譯文與 tooltip（content script）、side panel 的逐字稿（src/ui/side-panel.css 的 .translation）都用它。
 * 用的地方把 font-family 寫成 PUNCTUATION_FAMILY, var(--naru-font-sans)；unicode-range 只涵蓋這幾個標點。
 */
import { PUNCTUATION_UNICODE_RANGE, PUNCTUATION_WOFF2_BASE64 } from './punctuation-font.ts';

export const PUNCTUATION_FAMILY = 'Naruhodo Punctuation TC';

let loaded: Promise<void> | undefined;

/**
 * 載入一次，加到 document.fonts（shadow root 裡也看得到）。FontFace 直接吃位元組、不經過網址，
 * 所以不受網頁 CSP 的 font-src 限制。失敗就用系統字型的標點。
 */
export function loadPunctuationFont(): Promise<void> {
  loaded ??= (async () => {
    const bytes = Uint8Array.from(atob(PUNCTUATION_WOFF2_BASE64), (c) => c.charCodeAt(0));
    const face = new FontFace(PUNCTUATION_FAMILY, bytes, { weight: '100 900', unicodeRange: PUNCTUATION_UNICODE_RANGE });
    document.fonts.add(await face.load());
  })().catch((e: unknown) => console.warn('punctuation font failed, falling back to system punctuation', e));
  return loaded;
}
