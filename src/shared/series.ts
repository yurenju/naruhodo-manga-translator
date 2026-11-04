/** Series 與網址模式（spec #27 第 4.1 節）。 */
export interface Series {
  /** 外掛產生的 ID，不是網站的 ID。 */
  id: string;
  /** 選單顯示的名稱：讀者取的名稱；自動建的是 Original Title，猜不出來是「未命名・網站・日期」。 */
  name: string;
  /**
   * Provisional Series＝讀者還沒確認（#186）：自動歸類照樣命中它。只有明確的動作才拿掉（「是」、取名字／改名、
   * 選一部確認過的作品、合併進別部）；ID 不變（#36）。
   */
  provisional: boolean;
  createdAt: number;
  /**
   * Original Title（#186）：從頁面標題猜出的作品原名，可以有多個（讀者選擇或合併時記下）。猜到的原名正規化後
   * 跟其中一個相同就是同一部作品。#186 以前建的 Series 沒有這個欄位。
   */
  originalTitles?: string[];
  /** 建立時猜的中文譯名，只當顯示用的副標，之後不更新；讀者改名就拿掉（以讀者的名稱為準）。 */
  zhTitle?: string;
}

/**
 * 網址模式：完整網址（origin＋path，忽略 query 與 hash）對應到一個 Series。一個 Series 可以有很多條；
 * 只在確認（選定非 Provisional 的 Series、「是」、改名、合併）之後才記住。
 */
export interface UrlPattern {
  pattern: string;
  seriesId: string;
  lastUsedAt: number;
}

/** side panel 的 Series 下拉選單的一項，已排好順序（最近用過的在最上面）。 */
export interface SeriesOption extends Series {
  /** 選單顯示的文字：Series 的名稱（自動建的是原名）。 */
  label: string;
  /** 作品卡的大字：猜的中文譯名，讀者取過名稱（或沒有譯名）就是名稱。 */
  title: string;
  /** 作品卡的小字：原名；跟大字一樣就沒有。 */
  subtitle?: string;
}

/** 猜到的作品（#186）：原名與只當副標的中文譯名。猜不出來是 undefined。 */
export interface TitleGuess {
  原名: string;
  中文譯名: string;
}

/** 比對原名用：NFKC（全形半形）、連續空白併成一個、去掉頭尾空白。 */
export const normalizeTitle = (title: string) => title.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** 送給翻譯 LLM 的作品名（#186）：原名優先，沒有就是讀者取的名稱；未命名的 Provisional Series 沒有。 */
export function seriesNameForLlm(series: Series | undefined): string | undefined {
  if (!series) return undefined;
  return series.originalTitles?.[0] ?? (series.provisional ? undefined : series.name);
}
