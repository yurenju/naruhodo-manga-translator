/**
 * 產生產品網站首頁展示（#109）用的辨識結果與譯文：site/src/demo/demo-page.json。
 * 內容是外掛真的翻 Practice Spread 的結果（真的 OCR、真的翻譯），只取右頁（跨頁的第一頁），從開著的 debug Chrome 的翻譯快取讀出來：
 *   1. `npm run debug:chrome`，開試翻頁、`npm run debug:activate`，等右頁翻完
 *   2. `node scripts/site-demo-page.ts`
 * Practice Spread 的圖、OCR 或翻譯改了就重錄。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import practiceSpread from '../practice-spread/ocr.json' with { type: 'json' };
import type { DemoPageData } from '../site/src/demo/demo-page.ts';
import type { PageTranslation, RatioRect } from '../src/shared/page-text.ts';
import { isPracticeSpreadPage, type PracticeSpreadText } from '../src/shared/practice-spread.ts';

/** 跨頁從右頁開始讀：右頁是右半張，也是 ocr.json 每種跑法的第 0 頁。 */
const RIGHT_PAGE: RatioRect = { x: 0.5, y: 0, w: 0.5, h: 1 };
const RIGHT_PAGE_INDEX = 0;

/** 在外掛的 service worker 裡讀最近翻的幾頁（翻譯快取可能有上百頁，只拿最新的）。 */
const READ_RECENT = `new Promise((resolve, reject) => {
  const open = indexedDB.open('naruhodo');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const all = open.result.transaction('pageTranslations').objectStore('pageTranslations').getAll();
    all.onerror = () => reject(all.error);
    all.onsuccess = () => resolve(all.result.sort((a, b) => b.translatedAt - a.translatedAt).slice(0, 20));
  };
})`;

const fixture = practiceSpread as PracticeSpreadText;
const pageOf = (index: number): PracticeSpreadText =>
  Object.fromEntries(Object.entries(fixture).map(([run, pages]) => [run, [pages[index]!]]));
const texts = (page: PageTranslation) => [...page.balloons, ...page.looseText].map((t) => t.原文);

const output = execFileSync(process.execPath, ['scripts/debug-eval.ts', 'sw', '-e', READ_RECENT], { encoding: 'utf8', maxBuffer: 64 << 20 });
const recent = JSON.parse(output) as PageTranslation[];

const page = recent.find((p) => isPracticeSpreadPage(texts(p), pageOf(RIGHT_PAGE_INDEX)));
if (!page) throw new Error('翻譯快取裡找不到 Practice Spread 的右頁：先在 debug Chrome 翻一次試翻頁');
const pages: DemoPageData[] = [{ pageHash: page.pageHash, sub: RIGHT_PAGE, text: { balloons: page.balloons, looseText: page.looseText } }];

writeFileSync(new URL('../site/src/demo/demo-page.json', import.meta.url), `${JSON.stringify(pages, null, 2)}\n`);
console.log(pages.map((p, i) => `第 ${i + 1} 頁：${p.text.balloons.length} 個 Balloon、${p.text.looseText.length} 段 Loose Text`).join('\n'));
