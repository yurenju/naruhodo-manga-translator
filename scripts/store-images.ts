/**
 * 用法：node scripts/store-images.ts
 *   產出 Chrome Web Store 的素材到 docs/webstore/：
 *   - screenshot-*.png：1280×800，從 README 的 docs/images/*.webp 等比放大／縮小後裁切
 *     （Web Store 要求滿版、不留 padding，所以裁切而不是補邊）
 *   - promo-small.png：440×280 的 small promo tile，用 logo 母檔加名稱與標語
 *   改了來源圖才需要重跑，產出的 PNG 一起 commit。
 *
 * 跟 scripts/icons.ts 一樣用 Playwright 的 Chromium 畫，不多裝影像函式庫。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = (name: string) => join(root, 'docs/webstore', name);

/**
 * 每張圖用 object-position 決定裁哪一邊：
 * overview 太寬，裁左邊的漫畫頁、保住右邊完整的 side panel；learning-mode 太高，裁下面、保住 panel 標題列。
 */
const SCREENSHOTS = [
  { source: 'docs/images/overview.webp', name: 'screenshot-1-overview.png', position: 'right center' },
  { source: 'docs/images/learning-mode.webp', name: 'screenshot-2-learning.png', position: 'center top' },
];

const dataUrl = async (path: string, type: string) =>
  `data:${type};base64,${(await readFile(join(root, path))).toString('base64')}`;

const browser = await chromium.launch();
try {
  for (const { source, name, position } of SCREENSHOTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(
      `<style>html,body{margin:0}img{display:block;width:1280px;height:800px;object-fit:cover;object-position:${position}}</style>` +
        `<img src="${await dataUrl(source, 'image/webp')}">`,
    );
    await page.screenshot({ path: out(name) });
    await page.close();
  }

  const svg = await readFile(join(root, 'src/icons/naruhodo.svg'), 'utf8');
  const tile = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await tile.setContent(`
    <style>
      html,body{margin:0}
      body{width:440px;height:280px;display:flex;align-items:center;gap:24px;padding:0 36px;box-sizing:border-box;
        background:#f4f1ea;color:#1f1d1a;font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif}
      svg{width:112px;height:112px;flex:none}
      h1{margin:0;font-size:40px;font-weight:700}
      p{margin:8px 0 0;font-size:20px;line-height:1.4;opacity:.9}
    </style>
    ${svg}
    <div><h1>Naruhodo</h1><p>日文漫畫翻譯<br>原地翻成中文，邊看邊學</p></div>`);
  await tile.screenshot({ path: out('promo-small.png') });
} finally {
  await browser.close();
}
console.log('store images → docs/webstore/');
