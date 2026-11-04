/**
 * 頁面上看得到作品名的文字（#186、ADR 0010）：document.title、og:title、前幾個 h1～h3。不讀網址。
 * readTitleSignals 由 SW 用 chrome.scripting.executeScript 在頁面裡執行，所以不能用到外面的任何東西。
 */
import type { TitleSignals } from './translator.ts';

/** 在頁面裡執行：讀標題、og:title、前 3 個 h1～h3。每段去掉多餘空白，最多 200 字（Worker 收 500 字以內）。 */
export function readTitleSignals(): TitleSignals {
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const headings = [...document.querySelectorAll('h1, h2, h3')].map((h) => clean(h.textContent)).filter((t) => t !== '').slice(0, 3);
  return {
    title: clean(document.title),
    ogTitle: clean(document.querySelector('meta[property="og:title"]')?.getAttribute('content')),
    headings,
  };
}
