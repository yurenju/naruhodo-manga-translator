/**
 * 把每個 tab 的 Page 外圈（shared/page-outlines.ts，#285 翻譯中、#283 等待中）送到 content script。
 * transcriber 每次 publish 都帶整串 Page；內容沒變就不重送。
 */
import type { PageOutlines, PageView } from '../shared/messages.ts';
import { pageOutlines } from '../shared/page-outlines.ts';

const NONE = '[]';

export function createOutlineSync(send: (tabId: number, pages: PageOutlines[]) => void) {
  /** 每個 tab 上次送出的內容；沒送過＝content script 上面沒有外圈。 */
  const sent = new Map<number, string>();

  return {
    publish(tabId: number, pages: readonly PageView[]): void {
      const outlines = pageOutlines(pages);
      const key = JSON.stringify(outlines);
      if ((sent.get(tabId) ?? NONE) === key) return;
      sent.set(tabId, key);
      send(tabId, outlines);
    },
    /** 重新整理、換頁、停止：content script 是新的（或已經收掉），上面沒有外圈。 */
    reset(tabId: number): void {
      sent.delete(tabId);
    },
  };
}
