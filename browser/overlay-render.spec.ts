/**
 * 第 2 層（spec #27 第 12 節）：覆蓋渲染。在 e2e build 的外掛測試頁把合成頁的 ground truth 直接畫成覆蓋層
 * （不跑 OCR），量每個譯文元素的 rect、斷言落在對應的 Balloon 內，並存截圖。
 * 顯示寬度跟仿 canvas 網站一樣是 430（倍率約 0.49），最小畫面字級 9px 才有作用。
 */
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Rect } from '../src/shared/messages.ts';
import type { PageMode } from '../src/shared/page-mode.ts';
import { boxToRatio, tupleBox } from '../src/content/overlay-layout.ts';
import type { EraseData, PageText, RatioRect } from '../src/shared/page-text.ts';
import { eraseImage, type EraseImage } from '../src/offscreen/erase-image.ts';
import { groundTruthPageTexts, pngDataUrl, readGroundTruth, readRgba, SYNTHETIC_IDS } from '../src/testing/synthetic.ts';
import { expect, test } from './fixtures.ts';
import { overlayTexts, type ScreenRect } from './overlay-helpers.ts';

const SYNTHETIC = new URL('../testdata/synthetic/out/', import.meta.url);

/** 跟仿 canvas 網站一樣的單頁顯示寬度；Spread 兩倍。 */
const PAGE_WIDTH = 430;

declare global {
  var __renderOverlay: (input: { image: string; width: number; pages: { sub: RatioRect; text: PageText }[]; pageMode?: PageMode }) => Promise<void>;
  var __overlayCapture: (phase: 'hide' | 'restore', long: boolean) => Promise<void>;
  var __overlayCovered: () => Rect[];
}

async function render(page: Page, id: string, width: number, pages = groundTruthPageTexts(id), pageMode?: PageMode): Promise<void> {
  const image = `data:image/png;base64,${(await readFile(new URL(`${id}.png`, SYNTHETIC))).toString('base64')}`;
  await page.evaluate((input) => globalThis.__renderOverlay(input), { image, width, pages, pageMode });
}

/** offscreen 的 encodeErase 在 Node 裡的版本：小圖編成 PNG data URL、位置換成比例。 */
function eraseData({ box, rgba }: EraseImage, page: { width: number; height: number }): EraseData {
  return { box: boxToRatio(tupleBox(box), page), image: pngDataUrl({ data: rgba, width: box[2], height: box[3] }) };
}

const anchorRect = (page: Page): Promise<ScreenRect> =>
  // 擦除小圖也是 img（在覆蓋層的 shadow root 裡，locator 會穿進去）
  page.locator('img:not(.er)').evaluate((img) => {
    const r = img.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

test.describe('覆蓋渲染（ground truth）', () => {
  test.use({ viewport: { width: 1000, height: 1400 } });

  for (const id of SYNTHETIC_IDS) {
    test(`${id}：每個譯文元素都落在對應的 Balloon 內，字級不小於畫面 9px`, async ({ context, extensionId }, testInfo) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
      const gt = readGroundTruth(id);
      const width = (PAGE_WIDTH * gt.width) / 880;
      await render(page, id, width);

      const anchor = await anchorRect(page);
      const scale = anchor.width / gt.width;
      const texts = await overlayTexts(page);
      const expected = groundTruthPageTexts(id).flatMap((p) => p.text.balloons.map((b) => b.id));
      expect(texts.map((t) => t.id).sort()).toEqual([...expected].sort());
      for (const text of texts) {
        const [x, y, w, h] = gt.texts.find((t) => t.id === text.id)!.bbox;
        const balloon = { x: anchor.x + x * scale, y: anchor.y + y * scale, width: w * scale, height: h * scale };
        expect.soft(text.rect.x, `${text.id} 左`).toBeGreaterThanOrEqual(balloon.x - 0.5);
        expect.soft(text.rect.y, `${text.id} 上`).toBeGreaterThanOrEqual(balloon.y - 0.5);
        expect.soft(text.rect.x + text.rect.width, `${text.id} 右`).toBeLessThanOrEqual(balloon.x + balloon.width + 0.5);
        expect.soft(text.rect.y + text.rect.height, `${text.id} 下`).toBeLessThanOrEqual(balloon.y + balloon.height + 0.5);
        expect.soft(text.screenFontPx, `${text.id} 畫面字級`).toBeGreaterThanOrEqual(9 - 0.01);
      }
      console.log(`${id}`, texts.map((t) => `${t.id} 第${t.fit}階 ${t.screenFontPx.toFixed(1)}px`).join(' / '));
      const shot = testInfo.outputPath(`${id}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      await testInfo.attach(id, { path: shot, contentType: 'image/png' });
    });
  }

  test('p05 的「～」直書時是直的', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    // 原尺寸顯示，字形才夠大到能量
    await render(page, 'p05-dense', 880);

    const clip = await page.evaluate(() => {
      const host = document.querySelector('[data-naruhodo-overlay]')!;
      const tx = host.shadowRoot!.querySelector('[data-balloon-id="t4"]')!;
      const walker = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent!.indexOf('～');
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        return { vertical: getComputedStyle(tx).writingMode, x: r.x, y: r.y, width: r.width, height: r.height };
      }
      throw new Error('no ～');
    });
    expect(clip.vertical).toBe('vertical-rl');
    // 直書時字框的寬是行高，左右會碰到隔壁欄；只量中間的 em 正方形（邊長＝字框高）
    const em = { x: clip.x + (clip.width - clip.height) / 2, y: clip.y, width: clip.height, height: clip.height };
    const png = await page.screenshot({ clip: em });
    const ink = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let [left, top, right, bottom] = [width, height, -1, -1];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i]! + data[i + 1]! + data[i + 2]! < 3 * 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return { width: right - left + 1, height: bottom - top + 1 };
    }, `data:image/png;base64,${png.toString('base64')}`);
    console.log('～ 的字形墨跡', JSON.stringify(ink), '字框', JSON.stringify(clip));
    // 橫書的 ～ 是扁的；直書字形是直的
    expect(ink.height).toBeGreaterThan(ink.width * 1.5);
  });

  // unit test 驗不到：content script 真的把 PNG data URL 貼在 Page 層的正確位置、縮放跟著 Page 層走
  test('有擦除小圖的 Balloon 原樣貼上（橢圓外的角保留原本的底色）；舊快取沒有小圖的維持矩形', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    const id = 'p09-erase';
    const gt = readGroundTruth(id);
    const image = readRgba(id);
    const { sub, text } = groundTruthPageTexts(id)[0]!;
    // t1 帶擦除小圖；t7 當成舊快取，沒有小圖
    const t1 = gt.texts.find((t) => t.id === 't1')!;
    const erase = eraseImage(image, tupleBox(t1.bbox), tupleBox(t1.textBbox))!;
    const balloons = text.balloons.map((b) => (b.id === 't1' ? { ...b, erase: eraseData(erase, gt) } : b));
    // 原尺寸顯示，Page 像素＝畫面 px
    await render(page, id, gt.width, [{ sub, text: { ...text, balloons } }]);

    const tags = await page.evaluate(() => {
      const root = document.querySelector('[data-naruhodo-overlay]')!.shadowRoot!;
      // 量底色時藏起譯文
      for (const tx of root.querySelectorAll<HTMLElement>('.tx')) tx.style.visibility = 'hidden';
      return Object.fromEntries([...root.querySelectorAll<HTMLElement>('[data-erase-id]')].map((el) => [el.dataset.eraseId, el.tagName]));
    });
    expect(tags.t1).toBe('IMG');
    expect(tags.t7).toBe('DIV');
    // 文字框的左上角在泡泡外（灰底 180）：矩形擦除會蓋成白色，小圖保留原本的灰
    const anchor = await anchorRect(page);
    const [tx, ty] = t1.textBbox;
    const png = await page.screenshot({ clip: { x: anchor.x + tx, y: anchor.y + ty, width: 2, height: 2 } });
    const gray = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, 1, 1).data[0];
    }, `data:image/png;base64,${png.toString('base64')}`);
    expect(gray).toBeGreaterThan(170);
    expect(gray).toBeLessThan(190);
  });

  // unit test 驗不到：content script 真的把 Loose Text 畫上去、套上描邊，量到的譯文外框（真實排版）落在文字框內
  test('不是 Sound Effect 的 Loose Text 原地覆蓋（譯文在文字框內、反色描邊），Sound Effect 不覆蓋', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    const id = 'p09-erase';
    const gt = readGroundTruth(id);
    // 原尺寸顯示，Page 像素＝畫面 px
    await render(page, id, gt.width);

    const loose = await page.evaluate(() => {
      const root = document.querySelector('[data-naruhodo-overlay]')!.shadowRoot!;
      return [...root.querySelectorAll<HTMLElement>('[data-loose-id]')].map((el) => {
        const inner = el.firstElementChild!.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          id: el.dataset.looseId!,
          inner: { x: inner.x, y: inner.y, width: inner.width, height: inner.height },
          color: style.color,
          stroke: parseFloat(style.webkitTextStrokeWidth),
          strokeColor: style.webkitTextStrokeColor,
          fontPx: parseFloat(style.fontSize),
        };
      });
    });
    const erased = await page.evaluate(() =>
      [...document.querySelector('[data-naruhodo-overlay]')!.shadowRoot!.querySelectorAll<HTMLElement>('[data-erase-id]')].map((el) => el.dataset.eraseId),
    );

    // t10 是 Sound Effect（ぱちっ）：沒有譯文、也沒有擦除底色
    expect(loose.map((l) => l.id).sort()).toEqual(['t11', 't12', 't8', 't9']);
    expect(erased).not.toContain('t10');
    expect(erased).toEqual(expect.arrayContaining(['t8', 't9', 't11', 't12']));
    const anchor = await anchorRect(page);
    for (const l of loose) {
      const [x, y, w, h] = gt.texts.find((t) => t.id === l.id)!.textBbox;
      expect.soft(l.inner.x, `${l.id} 左`).toBeGreaterThanOrEqual(anchor.x + x - 0.5);
      expect.soft(l.inner.y, `${l.id} 上`).toBeGreaterThanOrEqual(anchor.y + y - 0.5);
      expect.soft(l.inner.x + l.inner.width, `${l.id} 右`).toBeLessThanOrEqual(anchor.x + x + w + 0.5);
      expect.soft(l.inner.y + l.inner.height, `${l.id} 下`).toBeLessThanOrEqual(anchor.y + y + h + 0.5);
      // 描邊約字級的 1/8（paint-order: stroke 讓一半蓋在字下，外側露出 1/8）
      expect.soft(l.stroke, `${l.id} 描邊`).toBeCloseTo(l.fontPx / 4, 1);
    }
    // 黑底白字（t12）：白字黑邊；其他是淺色底：黑字白邊
    const t12 = loose.find((l) => l.id === 't12')!;
    expect(t12.color).toBe('rgb(255, 255, 255)');
    expect(t12.strokeColor).toBe('rgb(17, 17, 17)');
    const t8 = loose.find((l) => l.id === 't8')!;
    expect(t8.color).toBe('rgb(17, 17, 17)');
    expect(t8.strokeColor).toBe('rgb(255, 255, 255)');
    // Balloon 不加描邊
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-naruhodo-overlay]')!.shadowRoot!.querySelector('[data-balloon-id]')!).webkitTextStrokeWidth)).toBe('0px');
  });

  // unit test 驗不到：瀏覽器真的排出來的譯文（字型、斷行、縮字之後）是不是落在擦除範圍內
  test('有排版矩形時，譯文的實際外框落在擦除範圍內（#150）', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    const id = 'p09-erase';
    const gt = readGroundTruth(id);
    const image = readRgba(id);
    const { sub, text } = groundTruthPageTexts(id)[0]!;
    const erases = new Map(
      gt.texts.flatMap((t) => {
        const erase = eraseImage(image, tupleBox(t.bbox), tupleBox(t.textBbox));
        return erase ? [[t.id, erase] as const] : [];
      }),
    );
    const balloons = text.balloons.map((b) => {
      const erase = erases.get(b.id);
      return erase ? { ...b, erase: { ...eraseData(erase, gt), fit: boxToRatio(tupleBox(erase.fit), gt) } } : b;
    });
    // 原尺寸顯示，Page 像素＝畫面 px
    await render(page, id, gt.width, [{ sub, text: { ...text, balloons } }]);

    const anchor = await anchorRect(page);
    const spans = await page.evaluate(() =>
      [...document.querySelector('[data-naruhodo-overlay]')!.shadowRoot!.querySelectorAll<HTMLElement>('[data-balloon-id]')].map((el) => {
        const r = el.firstElementChild!.getBoundingClientRect();
        return { id: el.dataset.balloonId!, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
    expect(spans.filter((s) => erases.has(s.id)).length).toBeGreaterThan(0);
    for (const span of spans) {
      const erase = erases.get(span.id);
      if (!erase) continue;
      const [ex, ey, ew] = erase.box;
      // 譯文外框（往內 1px 容許次像素誤差）蓋到的每個像素，都要在擦除小圖的 alpha 裡
      let outside = 0;
      for (let y = Math.ceil(span.y - anchor.y + 1); y < Math.floor(span.y - anchor.y + span.h - 1); y++)
        for (let x = Math.ceil(span.x - anchor.x + 1); x < Math.floor(span.x - anchor.x + span.w - 1); x++) {
          const [lx, ly] = [x - ex, y - ey];
          if (lx < 0 || ly < 0 || lx >= ew || ly >= erase.box[3] || erase.rgba[(ly * ew + lx) * 4 + 3] === 0) outside++;
        }
      expect.soft(outside, `${span.id} 的譯文有 ${outside} 個像素在擦除範圍外`).toBe(0);
    }
  });

  test('譯文太長時截斷，字級仍不小於畫面 9px，滑過時 tooltip 顯示原文＋ルビ＋譯文全文', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    const pages = groundTruthPageTexts('p01-basic').map(({ sub, text }) => ({
      sub,
      text: { ...text, balloons: text.balloons.map((b) => ({ ...b, 譯文: b.譯文.repeat(8) })) },
    }));
    await render(page, 'p01-basic', PAGE_WIDTH, pages);

    const texts = await overlayTexts(page);
    console.log('譯文 ×8', texts.map((t) => `${t.id} 第${t.fit}階 ${t.screenFontPx.toFixed(1)}px`).join(' / '));
    for (const text of texts) expect(text.screenFontPx).toBeGreaterThanOrEqual(9 - 0.01);
    const truncated = texts.find((t) => t.fit === 3);
    expect(truncated).toBeDefined();
    const balloon = pages[0]!.text.balloons.find((b) => b.id === truncated!.id)!;

    const tooltip = page.locator('[data-naruhodo-overlay] .tip');
    await expect(tooltip).toBeHidden();
    await page.mouse.move(truncated!.rect.x + truncated!.rect.width / 2, truncated!.rect.y + truncated!.rect.height / 2);
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('.tip-zh')).toHaveText(balloon.譯文);
    // 原文去掉ルビ後就是 ground truth 原文
    expect(await tooltip.locator('.tip-ja').evaluate((el) => {
      const copy = el.cloneNode(true) as Element;
      copy.querySelectorAll('rt, .tip-guess').forEach((rt) => rt.remove());
      return copy.textContent;
    })).toBe(balloon.原文);
    await expect(tooltip).toContainText('讀音為推測');
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  // unit 測不到的：真的 DOM 上截圖時哪些元素看得到，以及 coveredRects 量到的是畫面上的擦除與譯文
  test('長 Page 截圖時擦除與譯文留著、tooltip 與高亮框藏起來；covered 是畫面上的擦除與譯文', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    await render(page, 'p01-basic', PAGE_WIDTH);
    const [text] = await overlayTexts(page);
    const tooltip = page.locator('[data-naruhodo-overlay] .tip');
    const highlight = page.locator('[data-naruhodo-overlay] .hl');
    await page.mouse.move(text!.rect.x + text!.rect.width / 2, text!.rect.y + text!.rect.height / 2);
    await expect(tooltip).toBeVisible();
    await expect(highlight).toBeVisible();

    await page.evaluate(() => globalThis.__overlayCapture('hide', true));
    await expect(tooltip).toBeHidden();
    await expect(highlight).toBeHidden();
    await expect(page.locator('[data-naruhodo-overlay] .tx').first()).toBeVisible();
    const covered = await page.evaluate(() => globalThis.__overlayCovered());
    expect(covered).toHaveLength(await page.locator('[data-naruhodo-overlay] .er, [data-naruhodo-overlay] .tx').count());
    const anchor = await anchorRect(page);
    for (const r of covered) {
      expect(r.y).toBeGreaterThanOrEqual(anchor.y - 1);
      expect(r.y + r.height).toBeLessThanOrEqual(anchor.y + anchor.height + 1);
    }

    await page.evaluate(() => globalThis.__overlayCapture('restore', true));
    await expect(tooltip).toBeVisible();
  });

  test('學習時 Loose Text 的 tooltip 也有「譯」區塊、滑進才揭露；unreadable 的句子沒有「譯」區塊', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-overlay.html`);
    // p04：t1「遅刻だー!!」當成 unreadable；t2「ドドドド」是狀聲詞（Loose Text）
    const pages = groundTruthPageTexts('p04-outside').map(({ sub, text }) => ({
      sub,
      text: { ...text, balloons: text.balloons.map((b) => (b.id === 't1' ? { ...b, unreadable: true } : b)) },
    }));
    const loose = pages[0]!.text.looseText.find((l) => l.id === 't2')!;
    expect(loose.譯文).not.toBe('');
    await render(page, 'p04-outside', PAGE_WIDTH, pages, 'learn');
    const anchor = await anchorRect(page);
    const centerOf = (r: RatioRect) => ({ x: anchor.x + (r.x + r.w / 2) * anchor.width, y: anchor.y + (r.y + r.h / 2) * anchor.height });
    const tooltip = page.locator('[data-naruhodo-overlay] .tip.on');

    const looseCenter = centerOf(loose.bbox);
    await page.mouse.move(looseCenter.x, looseCenter.y);
    await expect(tooltip).toContainText(loose.原文);
    await expect(tooltip).not.toContainText(loose.譯文);
    const chipBox = (await tooltip.getByText('滑過這裡看譯文').boundingBox())!;
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2, { steps: 10 });
    await expect(tooltip).toContainText(loose.譯文);
    await page.mouse.move(1, 1);
    await expect(tooltip).toHaveCount(0);

    const unreadable = pages[0]!.text.balloons.find((b) => b.id === 't1')!;
    const unreadableCenter = centerOf(unreadable.balloonBbox);
    await page.mouse.move(unreadableCenter.x, unreadableCenter.y);
    await expect(tooltip).toContainText('無法辨識');
    await expect(tooltip.getByText('譯', { exact: true })).toHaveCount(0);
    await expect(tooltip).not.toContainText('滑過這裡看譯文');
  });
});
