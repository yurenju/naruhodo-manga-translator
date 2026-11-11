/**
 * 展示用的漫畫：Practice Spread（practice-spread/，原創、沒有版權問題）的右頁。整張跨頁縮進展示框字太小，只放一頁；
 * 圖還是整張跨頁，展示框只露出右半張（demo.css），覆蓋層跟外掛一樣用 sub 對到右半張。
 * 辨識結果與譯文是外掛真的翻一次錄下來的（demo-page.json），展示時不跑 OCR、不呼叫翻譯。
 * Practice Spread 改了就重錄：node scripts/site-demo-page.ts（步驟寫在腳本開頭）。
 */
import type { PageText, RatioRect } from '../../../src/shared/page-text.ts';
import recorded from './demo-page.json' with { type: 'json' };

/** 一個 Page：佔整張圖的哪一塊（sub），與它的辨識結果、譯文。 */
export interface DemoPageData {
  /**
   * 外掛錄下來的 Page hash。side panel 與覆蓋層 hover 同步靠它對上同一頁；覆蓋層用 Hamming 距離判斷兩層是不是同一頁，
   * 所以要是真的 hash，自己編的字串會被當成同一頁、互相蓋掉。
   */
  pageHash: string;
  sub: RatioRect;
  text: PageText;
}

/** 只有右頁；保留陣列，展示的進度與 side panel 都照多個 Page 寫。 */
export const demoPages = recorded as DemoPageData[];
