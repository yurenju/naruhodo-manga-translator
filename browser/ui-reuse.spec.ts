/**
 * #108：產品網站重用外掛的畫面。在一般網頁（about:blank：沒有 chrome.runtime、沒有 content script）注入 e2e build 的
 * test-ui.js，render src/ui 的 SidePanel 與 content/overlay.ts 的 createOverlay。
 * unit 抓不到的：shadow root 裡樣式真的套上、沒有漏到外面（瀏覽器的 cascade），以及覆蓋層真正的版面與滑鼠 hover。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import type { LineRef, PageView } from '../src/shared/messages.ts';
import { groundTruthPageTexts } from '../src/testing/synthetic.ts';
import { expect, test } from './fixtures.ts';
import type { StyleSnapshot } from '../src/test-ui/main.tsx';

const SCRIPT = fileURLToPath(new URL('../dist/e2e/test-ui.js', import.meta.url));
const SYNTHETIC = new URL('../testdata/synthetic/out/', import.meta.url);
const ID = 'p01-basic';

/** 一般網頁：不是外掛頁面，也沒有被外掛注入任何東西。 */
async function plainPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('about:blank');
  expect(await page.evaluate(() => typeof globalThis.chrome?.runtime?.sendMessage)).toBe('undefined');
  await page.addScriptTag({ path: SCRIPT });
  return page;
}

/** 翻好的一頁，第一句是頁面上滑鼠所在的那句（逐字稿那行高亮）。 */
function translatedPage(): { pages: PageView[]; hovered: LineRef } {
  const text = groundTruthPageTexts(ID)[0]!.text;
  const pageHash = 'demo';
  const page: PageView = {
    anchorId: 'a',
    rect: { x: 0, y: 0, width: 880, height: 1250 },
    thumbnail: '',
    pageHash,
    transcript: {
      state: 'done',
      text,
      translated: true,
      translation: { model: 'claude-x', latencyMs: 1200, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.001 }, source: 'translated' },
    },
  };
  return { pages: [page], hovered: { pageHash, lineId: text.balloons[0]!.id } };
}

test('SidePanel 放進 shadow root：外觀跟外掛的 side panel 一樣，樣式也不會漏到網頁上', async ({ context }) => {
  const props = translatedPage();
  // 外掛的樣子：樣式直接載入整頁（跟 sidepanel.html 一樣）
  const extensionLike = await plainPage(context);
  const expected = await extensionLike.evaluate((p) => globalThis.__testUi.renderSidePanel({ ...p, shadow: false }), props);

  const site = await plainPage(context);
  const before = await site.evaluate(() => globalThis.__testUi.pageStyles());
  const actual = await site.evaluate((p) => globalThis.__testUi.renderSidePanel({ ...p, shadow: true }), props);

  // 樣式真的有套上（不是兩邊都沒載入而相等）
  const footer = actual.find((e) => e.tag === 'footer')!;
  expect(footer.style.position).toBe('sticky');
  expect(actual.find((e) => e.tag === 'li' && e.class.includes('hl'))!.style['background-color']).not.toBe('rgba(0, 0, 0, 0)');
  expect(actual).toEqual(expected satisfies StyleSnapshot);
  // 網頁上同樣的 main、footer、input、ul[aria-label=Page]，以及 :root 的 tokens 都沒變
  expect(before.tokens).toBe('');
  expect(await site.evaluate(() => globalThis.__testUi.pageStyles())).toEqual(before);
  await expect(site.locator('.naru-side-panel').getByRole('button', { name: '閱讀', exact: true })).toBeVisible();
});

test('createOverlay 在一般網頁上獨立呼叫：閱讀畫出譯文，學習滑過 Balloon 出 tooltip', async ({ context }) => {
  const page = await plainPage(context);
  const image = `data:image/png;base64,${(await readFile(new URL(`${ID}.png`, SYNTHETIC))).toString('base64')}`;
  const pages = groundTruthPageTexts(ID);
  const balloons = pages.flatMap((p) => p.text.balloons);
  const translations = page.locator('[data-naruhodo-overlay] [data-balloon-id]');

  await page.evaluate((input) => globalThis.__testUi.renderOverlay({ ...input, pageMode: 'read' }), { image, pages });
  await expect(translations.filter({ visible: true })).toHaveCount(balloons.length);
  await expect(translations.filter({ hasText: balloons[0]!.譯文! })).toBeVisible();

  await page.evaluate((input) => globalThis.__testUi.renderOverlay({ ...input, pageMode: 'learn' }), { image, pages });
  await expect(translations.filter({ visible: true })).toHaveCount(0);
  // 譯文元素藏起來後 rect 不變（visibility），拿它當 Balloon 的位置
  const box = (await translations.first().boundingBox())!;
  const tooltip = page.locator('[data-naruhodo-overlay] .tip.on');
  await page.mouse.move(1, 1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(tooltip).toHaveCount(1);
  const id = await translations.first().getAttribute('data-balloon-id');
  // 原文夾著振り仮名（rt），拿掉再比
  const withoutRuby = await tooltip.evaluate((tip) => {
    const copy = tip.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('rt').forEach((rt) => rt.remove());
    return copy.textContent;
  });
  expect(withoutRuby).toContain(balloons.find((b) => b.id === id)!.原文);
});
