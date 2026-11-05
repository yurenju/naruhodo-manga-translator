/**
 * #32 第 3 層：整個外掛在仿 canvas 網站上原地覆蓋。OCR 用 FakeEngine 重播
 * （ADR 0007；@e2e 那條在 e2e 跑真模型），譯文來自 FakeTranslator。
 * 覆蓋層的框來自偵測結果，跟 ground truth 的 Balloon 框不會完全一樣，所以對齊判斷留幾 px 容許誤差。
 */
import type { Page, Worker } from '@playwright/test';
import { readGroundTruth } from '../src/testing/synthetic.ts';
import { activateOnMockSite, expect, rescan, sentOriginals, test, testStop } from './fixtures.ts';
import { WATERMARK_TEXT } from './mock-site/canvas-site.ts';
import { overlayHostCount, pageMode, shownErasers, shownTranslations, type ScreenRect } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

/** 偵測框與 ground truth 框的差距（畫面 px）。 */
const TOLERANCE = 4;

/** 仿 canvas 網站的頁面順序（browser/mock-site/canvas-site.ts）。 */
const PAGES = ['p01-basic', 'p02-ruby', 'p03-shapes', 'p04-outside', 'p05-dense', 'p06-horizontal'];

const normalize = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');

interface MockOverlayText {
  text: string;
  rect: ScreenRect;
  /** 這個 host 掛在第幾頁的 canvas 旁邊。 */
  pageIndex: number;
  anchor: ScreenRect;
}

function mockOverlayTexts(page: Page): Promise<MockOverlayText[]> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.viewer canvas')];
    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return [...document.querySelectorAll('[data-naruhodo-overlay]')].flatMap((host) => {
      const anchor = host.previousElementSibling!;
      return [...host.shadowRoot!.querySelectorAll('[data-balloon-id]')].map((el) => ({
        text: el.textContent ?? '',
        rect: rectOf(el),
        pageIndex: canvases.indexOf(anchor),
        anchor: rectOf(anchor),
      }));
    });
  });
}

/** 第 1、2 頁（完整可見的兩頁）都覆蓋好了。 */
async function waitForOverlay(page: Page): Promise<void> {
  await expect
    .poll(async () => new Set((await mockOverlayTexts(page)).map((t) => t.pageIndex)).size)
    .toBe(2);
}

/** 每個譯文元素都落在 ground truth 裡同一句的 Balloon（依 anchor 目前的畫面位置換算）內。 */
async function expectAligned(page: Page, label: string): Promise<void> {
  const texts = await mockOverlayTexts(page);
  expect(texts.length, label).toBeGreaterThanOrEqual(10);
  let matched = 0;
  for (const text of texts) {
    const gt = readGroundTruth(PAGES[text.pageIndex]!);
    const target = gt.texts.find((t) => normalize(t.zh) === normalize(text.text));
    if (!target) continue; // OCR 認錯、FakeTranslator 對不到的句子
    matched++;
    const scale = text.anchor.width / gt.width;
    const [x, y, w, h] = target.bbox;
    const balloon = { x: text.anchor.x + x * scale, y: text.anchor.y + y * scale, width: w * scale, height: h * scale };
    const where = `${label} p${text.pageIndex + 1} ${target.id}「${target.zh}」`;
    expect.soft(text.rect.x, `${where} 左`).toBeGreaterThanOrEqual(balloon.x - TOLERANCE);
    expect.soft(text.rect.y, `${where} 上`).toBeGreaterThanOrEqual(balloon.y - TOLERANCE);
    expect.soft(text.rect.x + text.rect.width, `${where} 右`).toBeLessThanOrEqual(balloon.x + balloon.width + TOLERANCE);
    expect.soft(text.rect.y + text.rect.height, `${where} 下`).toBeLessThanOrEqual(balloon.y + balloon.height + TOLERANCE);
  }
  console.log(`${label}：${texts.length} 個譯文，${matched} 個對到 ground truth`);
  expect(matched, label).toBeGreaterThanOrEqual(10);
}

const hostVisibility = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-naruhodo-overlay]')].map((h) => getComputedStyle(h).visibility));

test('譯文蓋在 Balloon 上；捲動、祖先 transform 縮放後仍對齊；Page Mode 切到學習時頁面沒有譯文', { tag: '@e2e' }, async ({ context, sw, extensionId, mockSite }, testInfo) => {
  const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await waitForOverlay(page);

  await expectAligned(page, '剛覆蓋');
  const shot = testInfo.outputPath('overlay.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('overlay', { path: shot, contentType: 'image/png' });
  // 打包的 Noto Sans TC 有載入（content script 透過 web_accessible_resources 讀到字型檔）
  expect(await page.evaluate(() => document.fonts.check('700 26px "Naruhodo Noto Sans TC"', '早安'))).toBe(true);

  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expectAligned(page, '捲動後');

  // 仿電子書閱讀器縮放：祖先元素的 transform
  await page.evaluate(() => {
    const viewer = document.querySelector<HTMLElement>('.viewer')!;
    viewer.style.transformOrigin = '0 0';
    viewer.style.transform = 'translate(-120px, -80px) scale(1.4)';
  });
  await expectAligned(page, '縮放後');
  const zoomed = testInfo.outputPath('overlay-zoomed.png');
  await page.screenshot({ path: zoomed });
  await testInfo.attach('overlay-zoomed', { path: zoomed, contentType: 'image/png' });

  // Page Mode：預設閱讀；學習時頁面上沒有譯文（擦字也拿掉），host 照常顯示（tooltip、高亮框還要用）
  await expect(pageMode(panel, '閱讀')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('switch', { name: '覆蓋' })).toHaveCount(0);
  await expect(shownTranslations(page)).not.toHaveCount(0);
  await pageMode(panel, '學習').click();
  await expect(pageMode(panel, '學習')).toHaveAttribute('aria-pressed', 'true');
  await expect(pageMode(panel, '閱讀')).toHaveAttribute('aria-pressed', 'false');
  await expect(shownTranslations(page)).toHaveCount(0);
  await expect(shownErasers(page)).toHaveCount(0);
  // 截圖前 host 會暫時藏起來（content:prepareCapture），剛好碰上擷取就要等它結束
  await expect.poll(() => hostVisibility(page)).toEqual(['visible', 'visible']);
  await pageMode(panel, '閱讀').click();
  await expect(shownTranslations(page)).not.toHaveCount(0);
  await expectAligned(page, '切回閱讀後');
});

test('主頁面重繪把 host 拿掉後自動掛回；停止後所有 host 消失、position 還原', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await waitForOverlay(page);
  const positions = () =>
    page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.viewer .page')].slice(0, 2).map((s) => [s.style.position, getComputedStyle(s).position]));
  // 仿 canvas 網站的 .page 原本是 static，掛 host 時改成 relative
  expect(await positions()).toEqual([
    ['relative', 'relative'],
    ['relative', 'relative'],
  ]);

  // 框架重繪：slot 只留下 canvas，我們的 host 被丟掉
  await page.evaluate(() => {
    for (const slot of [...document.querySelectorAll('.viewer .page')].slice(0, 2)) slot.replaceChildren(slot.querySelector('canvas')!);
  });
  await expect.poll(() => overlayHostCount(page)).toBe(2);
  await expectAligned(page, '重掛後');

  await testStop(panel, tabId);
  await expect.poll(() => overlayHostCount(page)).toBe(0);
  expect(await positions()).toEqual([
    ['', 'static'],
    ['', 'static'],
  ]);
});

test('已翻譯的頁重新擷取時不藏覆蓋層（用帶覆蓋層的樣子認頁），也不會重翻', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel, tabId } = await activateOnMockSite({ context, sw, extensionId, mockSite });
  await waitForOverlay(page);
  // 覆蓋層畫好後 SW 會不藏覆蓋層補截一次（記下帶覆蓋層的樣子），等兩頁都記好
  await expect.poll(() => sw.evaluate(() => globalThis.__overlaidRecords ?? 0)).toBeGreaterThanOrEqual(2);
  const screenshot = async () => `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
  const setHostDisplay = (display: string) =>
    page.evaluate((display) => {
      for (const host of document.querySelectorAll<HTMLElement>('[data-naruhodo-overlay]')) host.style.display = display;
    }, display);
  // 基準：把覆蓋層整個拿掉時的畫面（side panel 打開後版面才固定，所以不用最早的那張截圖）
  await setHostDisplay('none');
  const withoutOverlay = await screenshot();
  await setHostDisplay('');
  const hiddenBefore = (await overlayHiddenMs(sw, tabId)).length;
  const translateCalls = await sw.evaluate(() => globalThis.__translateCalls ?? 0);

  // 覆蓋層顯示中再擷取一次（SW 的 captureVisibleTab）
  const requestedAt = await sw.evaluate(() => Date.now());
  await rescan(panel, tabId);
  const captured = await captureStartedAfter(sw, requestedAt);

  // 截圖裡有我們的中文（沒藏），覆蓋層一直是顯示的，頁也還認得（沒有重翻）
  const capturedDiff = await changedFraction(page, withoutOverlay, captured);
  console.log(`跟沒有覆蓋層的畫面相比，SW 截圖的像素變化比例：${capturedDiff.toFixed(5)}`);
  expect(capturedDiff).toBeGreaterThan(0.005);
  expect((await overlayHiddenMs(sw, tabId)).length).toBe(hiddenBefore);
  await expect.poll(() => hostVisibility(page)).toEqual(['visible', 'visible']);
  // 斷言「沒有重翻」：等一段時間確認翻譯次數沒變
  await page.waitForTimeout(1_000);
  expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(translateCalls);
  await waitForOverlay(page);
});

/** 兩張截圖之間 RGB 任一通道差超過 32 的像素比例。 */
function changedFraction(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const load = async (url: string) => createImageBitmap(await (await fetch(url)).blob());
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) throw new Error(`size differs: ${x.width}x${x.height} vs ${y.width}x${y.height}`);
      const pixels = (bitmap: ImageBitmap) => {
        const canvas = new OffscreenCanvas(x.width, x.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0, x.width, x.height);
        return ctx.getImageData(0, 0, x.width, x.height).data;
      };
      const [p, q] = [pixels(x), pixels(y)];
      let changed = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (Math.abs(p[i]! - q[i]!) > 32 || Math.abs(p[i + 1]! - q[i + 1]!) > 32 || Math.abs(p[i + 2]! - q[i + 2]!) > 32) changed++;
      }
      return changed / (p.length / 4);
    },
    [a, b] as const,
  );
}

/**
 * 等 SW 截好一張 time（SW 的 Date.now()）之後才開始截的圖。`__captureLog` 在開始截時就記，
 * 看到它變多就讀 `__captures` 會拿到上一張（#103）。
 */
async function captureStartedAfter(sw: Worker, time: number): Promise<string> {
  const find = () => sw.evaluate((t) => globalThis.__captures?.findLast((c) => c.startedAt > t)?.screenshot, time);
  await expect.poll(find).toBeDefined();
  return (await find())!;
}

/** content script（isolated world）記下的每次截圖時覆蓋層被藏了多久。 */
async function overlayHiddenMs(sw: Worker, tabId: number): Promise<number[]> {
  return sw.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__overlayHiddenMs ?? [] });
    return (result?.result as number[] | undefined) ?? [];
  }, tabId);
}

/** 截圖裡某個元素範圍內，洋紅（浮水印）與青色（疊上去的 img）像素各佔多少。 */
function colorFractions(page: Page, screenshot: string, selector: string): Promise<{ magenta: number; cyan: number }> {
  return page.evaluate(
    async ([url, selector]) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const scale = bitmap.width / innerWidth;
      const r = document.querySelector(selector)!.getBoundingClientRect();
      const [x, y, w, h] = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * scale)) as [number, number, number, number];
      const ctx = new OffscreenCanvas(w, h).getContext('2d')!;
      ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      let magenta = 0;
      let cyan = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [red, green, blue] = [data[i]!, data[i + 1]!, data[i + 2]!];
        if (red - green > 60 && blue - green > 60) magenta++;
        if (green - red > 150 && blue - red > 150) cyan++;
      }
      return { magenta: magenta / (w * h), cyan: cyan / (w * h) };
    },
    [screenshot, selector] as const,
  );
}

test.describe('疊在 Page 上的網站元素：截圖前藏起來（#59）', () => {
  test('真實的 canvas 網站的翻頁感應區（透明、半個畫面、貼邊小箭頭）蓋著也照常翻譯，譯文落在 Balloon 內', async ({ context, sw, extensionId, mockSite }) => {
    const { page } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: `${mockSite.canvasSiteUrl}?nav=1` });
    await waitForOverlay(page);
    await expectAligned(page, '翻頁感應區蓋著');
  });

  test('pointer-events: none 的浮水印被藏起來、不進 OCR；疊在上面的另一張 img 不藏（可能是漫畫本身）', async ({ context, sw, extensionId, mockSite }) => {
    const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: `${mockSite.canvasSiteUrl}?watermark=1&stacked=1` });
    await waitForOverlay(page);
    // 切到學習、點一下觸發重掃：版面已經穩定（截圖時的位置＝現在量到的位置），截圖裡也沒有自己的譯文
    await pageMode(panel, '學習').click();
    await expect(shownTranslations(page)).toHaveCount(0);
    const clickedAt = await sw.evaluate(() => Date.now());
    await page.mouse.click(5, 5);
    // 在那之前截好的可能還帶著自己的譯文，蓋住疊上去的 img
    const screenshot = await captureStartedAfter(sw, clickedAt);
    const watermark = await colorFractions(page, screenshot, '#watermark');
    expect(watermark.magenta, '截圖裡的浮水印').toBeLessThan(0.01);
    const stacked = await colorFractions(page, screenshot, '#stacked');
    expect(stacked.cyan, '截圖裡疊上去的 img').toBeGreaterThan(0.9);
    // 對照：畫面上浮水印確實蓋在 Page 上
    expect((await colorFractions(page, await page.screenshot().then((b) => `data:image/png;base64,${b.toString('base64')}`), '#watermark')).magenta).toBeGreaterThan(0.5);

    const sent = await sentOriginals(sw);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((s) => normalize(s).includes(normalize(WATERMARK_TEXT)))).toEqual([]);
  });
});
