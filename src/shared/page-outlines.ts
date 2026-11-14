/**
 * Page 上的外圈（#285、#283）：讀者看得出哪幾句正在翻、哪幾句還在等。
 * - 翻譯中（#285）：送出翻譯到譯文回來之間，每一句的日文上有一道擦除底色的光帶掃過（像日文正被一波波洗白），照閱讀順序錯開；
 *   不畫框，因為大部分泡泡不是方的。譯文回來後整頁一次蓋上（不錯開），光帶同時收起。
 * - 等待中（#283）：被可見範圍的上緣或下緣切到、先不收的框，外圈一圈流動的藍色虛線。
 * 這裡是純函式：哪些句子要畫、光帶的範圍與蓋上譯文的先後；畫在 content/overlay.ts。
 */
import type { LineBox, PageOutlines, PageView } from './messages.ts';
import type { PageText, RatioRect } from './page-text.ts';

/** Loose Text 沒有泡泡外框：外圈畫在文字框往外這麼多畫面 px 的圓角矩形上。 */
export const LOOSE_OUTLINE_PAD_PX = 6;

/** 外框（Page 座標）在 anchor 上的位置（anchor 寬高的比例）；sub＝Page 在 anchor 裡的範圍（Spread 的一頁、去掉黑邊）。 */
export function onAnchor(box: RatioRect, sub: RatioRect): RatioRect {
  return { x: sub.x + box.x * sub.w, y: sub.y + box.y * sub.h, w: box.w * sub.w, h: box.h * sub.h };
}

/** 沒有擦除底色（舊快取）時當白底，跟覆蓋層擦除的預設一樣。 */
export const ERASE_WHITE = 255;

/** 翻譯中的光帶照閱讀順序錯開這麼久開始掃（ms），整頁看起來是一波波洗過去。 */
export const WASH_STAGGER_MS = 300;
/**
 * 送去翻譯的句子的外框。本機已經判成 unreadable 的（OCR 信心低於門檻，ADR 0009）不算：它們不管 LLM 怎麼回都不會被覆蓋，
 * 畫了外圈會讓人以為等一下有譯文。Loose Text 一律算：送出時還不知道哪些是 Sound Effect。
 */
export function translatingLines({ balloons, looseText }: PageText): LineBox[] {
  return [
    ...balloons
      .filter((b) => !b.unreadable)
      .map((b): LineBox => ({ id: b.id, kind: 'balloon', box: b.balloonBbox, order: b.order, textBox: b.textBbox, eraseLuminance: b.eraseLuminance ?? ERASE_WHITE })),
    ...looseText
      .filter((l) => !l.unreadable)
      .map((l): LineBox => ({ id: l.id, kind: 'loose', box: l.bbox, order: l.order, textBox: l.bbox, eraseLuminance: l.eraseLuminance ?? ERASE_WHITE })),
  ].sort((a, b) => a.order - b.order);
}

/** 底色掃光的範圍是文字框往外擴它寬高的這麼多倍，再往外羽化：光帶蓋住日文，不碰泡泡框線。 */
const WASH_GROW = 0.35;

/** 底色掃光的範圍（文字框往外擴 WASH_GROW），換成外圈 box 的比例；可以超出 0～1（Loose Text 的外圈就是文字框）。 */
export function washArea(box: RatioRect, text: RatioRect): RatioRect {
  const x = text.x - text.w * WASH_GROW;
  const y = text.y - text.h * WASH_GROW;
  return { x: (x - box.x) / box.w, y: (y - box.y) / box.h, w: (text.w * (1 + 2 * WASH_GROW)) / box.w, h: (text.h * (1 + 2 * WASH_GROW)) / box.h };
}

/** 這個 tab 畫面上有外圈要畫的 Page；沒有外圈的 Page 不列（content script 會拿掉它上面的外圈）。 */
export function pageOutlines(pages: readonly PageView[]): PageOutlines[] {
  return pages.flatMap(({ anchorId, pageHash, subRect, translatingLines: translating = [], waitingLines: waiting = [] }) =>
    translating.length + waiting.length === 0 ? [] : [{ anchorId, pageHash, ...(subRect ? { subRect } : {}), translating, waiting }],
  );
}

/** 每一句排第幾個（0 起算）：照閱讀順序，id → 第幾個。光帶的延遲是它乘上間隔。 */
export function staggerRanks(lines: readonly Pick<LineBox, 'id' | 'order'>[]): Map<string, number> {
  return new Map([...lines].sort((a, b) => a.order - b.order).map((line, i) => [line.id, i]));
}
