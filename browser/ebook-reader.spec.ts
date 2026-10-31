/**
 * #35：仿電子書閱讀器（整個 viewport 一張 blob img，Spread＋黑邊，翻頁換 src）。OCR 用 FakeEngine 重播
 * （ADR 0007；@e2e 那幾條在 e2e 跑真模型），譯文來自 FakeTranslator。
 * 外掛要去黑邊、從中縫切成兩個 Page，兩頁共用同一個 anchor 與 shadow host。
 * Spread 右頁先送出 LLM 的規則在 transcribe 的 unit。
 */
import type { Page, Worker } from '@playwright/test';
import { readGroundTruth, type GtText } from '../src/testing/synthetic.ts';
import { activateOnMockSite, expect, sentOriginals, test } from './fixtures.ts';
import { overlayHostCount, type ScreenRect } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

/** 偵測框與 ground truth 框的差距（畫面 px）。 */
const TOLERANCE = 4;

const normalize = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');

interface ReaderOverlay {
  texts: { text: string; rect: ScreenRect }[];
  /** img 的畫面 rect（含祖先 transform）與合成圖的像素尺寸。 */
  img: ScreenRect & { naturalWidth: number; naturalHeight: number };
}

function readerOverlay(page: Page): Promise<ReaderOverlay> {
  return page.evaluate(() => {
    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    // 多張 img 輪流用時（buffers）取看得到的那張；藏起來的 img 上的譯文也要看不到才算
    const img = [...document.querySelectorAll<HTMLImageElement>('#zoom > img')].find((el) => el.checkVisibility({ visibilityProperty: true }))!;
    const texts = [...document.querySelectorAll('[data-naruhodo-overlay]')].flatMap((host) =>
      [...host.shadowRoot!.querySelectorAll('[data-balloon-id]')]
        .filter((el) => el.checkVisibility({ visibilityProperty: true }))
        .map((el) => ({ text: el.textContent ?? '', rect: rectOf(el) })),
    );
    return { texts, img: { ...rectOf(img), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } };
  });
}

/** 這個合成頁（ground truth）的哪些句子有譯文蓋在畫面上；回傳每句在第幾頁（0＝右頁）。 */
async function overlaidTexts(page: Page, id: string): Promise<{ gt: GtText; rect: ScreenRect; img: ReaderOverlay['img'] }[]> {
  const { texts, img } = await readerOverlay(page);
  const gt = readGroundTruth(id);
  return texts.flatMap((t) => {
    const target = gt.texts.find((g) => normalize(g.zh) === normalize(t.text));
    return target ? [{ gt: target, rect: t.rect, img }] : [];
  });
}

/** ground truth 的 Balloon（Spread 原圖像素）換成畫面座標：合成圖是等比例縮放置中、周圍黑邊（browser/mock-site/ebook-reader.ts）。 */
function balloonOnScreen(id: string, bbox: GtText['bbox'], img: ReaderOverlay['img']): ScreenRect {
  const gt = readGroundTruth(id);
  const s = Math.min(img.naturalWidth / gt.width, img.naturalHeight / gt.height);
  const ox = Math.floor((img.naturalWidth - Math.round(gt.width * s)) / 2);
  const oy = Math.floor((img.naturalHeight - Math.round(gt.height * s)) / 2);
  const toScreen = img.width / img.naturalWidth;
  const [x, y, w, h] = bbox;
  return { x: img.x + (ox + x * s) * toScreen, y: img.y + (oy + y * s) * toScreen, width: w * s * toScreen, height: h * s * toScreen };
}

/** 要原地覆蓋的種類（其他是 Loose Text，不覆蓋）。 */
const OVERLAY_KINDS = new Set<GtText['kind']>(['balloon', 'thought', 'narration']);

/** 這張合成頁有要覆蓋的句子的 Page（p08 的右頁只有狀聲詞與框外文字，沒有東西可蓋）。 */
const overlayPages = (id: string) => [...new Set(readGroundTruth(id).texts.filter((t) => OVERLAY_KINDS.has(t.kind)).map((t) => t.page))].sort();

/** 有東西可蓋的每一頁都至少有一句譯文蓋上了。 */
async function waitForOverlay(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => [...new Set((await overlaidTexts(page, id)).map((t) => t.gt.page))].sort())
    .toEqual(overlayPages(id));
}

/** 每個譯文元素都落在 ground truth 裡同一句的 Balloon 內（右頁的句子在右半、左頁的在左半），有東西可蓋的頁都有。 */
async function expectAligned(page: Page, id: string, label: string): Promise<void> {
  const texts = await overlaidTexts(page, id);
  for (const { gt, rect, img } of texts) {
    const balloon = balloonOnScreen(id, gt.bbox, img);
    const where = `${label} ${id} ${gt.id}（第 ${gt.page} 頁）「${gt.zh}」`;
    expect.soft(rect.x, `${where} 左`).toBeGreaterThanOrEqual(balloon.x - TOLERANCE);
    expect.soft(rect.y, `${where} 上`).toBeGreaterThanOrEqual(balloon.y - TOLERANCE);
    expect.soft(rect.x + rect.width, `${where} 右`).toBeLessThanOrEqual(balloon.x + balloon.width + TOLERANCE);
    expect.soft(rect.y + rect.height, `${where} 下`).toBeLessThanOrEqual(balloon.y + balloon.height + TOLERANCE);
  }
  console.log(`${label}：${texts.length} 個譯文對到 ${id} 的 ground truth`);
  expect([...new Set(texts.map((t) => t.gt.page))].sort(), label).toEqual(overlayPages(id));
}

async function turnTo(page: Page, key: 'ArrowLeft' | 'ArrowRight', index: number): Promise<void> {
  await page.keyboard.press(key);
  await page.locator(`body[data-ready="true"][data-page-index="${index}"]`).waitFor();
}

test('Spread 切成兩頁：譯文各自落在自己的 Balloon 內；祖先 transform 後仍對齊', { tag: '@e2e' }, async ({ context, sw, extensionId, mockSite }, testInfo) => {
  const { page } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.ebookReaderUrl });
  await waitForOverlay(page, 'p07-spread');
  await expectAligned(page, 'p07-spread', '剛覆蓋');
  // 兩頁共用同一個 anchor 的 shadow host
  expect(await overlayHostCount(page)).toBe(1);
  const shot = testInfo.outputPath('ebook-reader-spread.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('ebook-reader-spread', { path: shot, contentType: 'image/png' });

  // 仿電子書閱讀器縮放／拖曳：祖先元素的 transform（縮小，img 仍完整在畫面內）
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#zoom')!.style.transform = 'translate(40px, 30px) scale(0.85)';
  });
  await expectAligned(page, 'p07-spread', '縮放後');
});

// 真模型在 p07 樹林上讀出的「それは、」最低信心約 0.06（錄製資料），低於門檻（ADR 0009）。只有這裡串得起
// 錄製資料 → FakeEngine → analyze → 合併 LLM 結果 → side panel 與覆蓋；門檻本身的規則在 analyze 的 unit。
test('OCR 信心低於門檻的段：LLM 有翻也標成無法辨識、不覆蓋；同頁其他 Balloon 照常覆蓋', async ({ context, sw, extensionId, mockSite }) => {
  const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.ebookReaderUrl });
  await waitForOverlay(page, 'p07-spread');

  const lowConfidence = panel.getByRole('list', { name: '逐字稿' }).getByRole('listitem').filter({ hasText: 'それは、' });
  await expect(lowConfidence).toContainText('無法辨識 · 未覆蓋');
  await expect(lowConfidence.locator('[lang="zh-Hant"]')).toHaveCount(0);
  expect(await sentOriginals(sw)).toContain('それは、');
});

test('換 src 翻頁後舊覆蓋消失、新 Spread 被翻譯；翻回來命中快取；重繪後 host 自動掛回', async ({ context, sw, extensionId, mockSite }) => {
  const { page } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.ebookReaderUrl });
  await waitForOverlay(page, 'p07-spread');

  await turnTo(page, 'ArrowLeft', 1);
  // 舊的 p07 譯文不能留在新的圖上
  await expect.poll(async () => (await overlaidTexts(page, 'p07-spread')).length).toBe(0);
  await waitForOverlay(page, 'p08-action');
  await expectAligned(page, 'p08-action', '翻頁後');
  // p08 的兩頁都翻了（右頁沒有 Balloon，但一樣送出 LLM）
  await expect.poll(() => sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(4);
  const translateCalls = 4;

  // 翻回來：同一個 img 又換 src，p07 從記住的結果重新覆蓋，不重翻
  await turnTo(page, 'ArrowRight', 0);
  await waitForOverlay(page, 'p07-spread');
  expect((await overlaidTexts(page, 'p08-action')).length).toBe(0);
  expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(translateCalls);

  // 框架重繪：#zoom 只留下 img，我們的 host 被丟掉
  await page.evaluate(() => {
    const zoom = document.querySelector('#zoom')!;
    zoom.replaceChildren(zoom.querySelector('#page')!);
  });
  await expect.poll(() => overlayHostCount(page)).toBe(1);
  await expectAligned(page, 'p07-spread', '重掛後');
});

test('多張 img 輪流用（visibility 切換）：翻頁後藏起來的那張上的舊譯文看不到，來回翻都只有目前的 Spread', async ({ context, sw, extensionId, mockSite }) => {
  const { page } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: `${mockSite.ebookReaderUrl}?buffers=3` });
  await waitForOverlay(page, 'p07-spread');

  await turnTo(page, 'ArrowLeft', 1);
  await waitForOverlay(page, 'p08-action');
  expect((await overlaidTexts(page, 'p07-spread')).length, '翻到 p08 後還看得到 p07 的譯文').toBe(0);
  await expectAligned(page, 'p08-action', '翻頁後');

  await turnTo(page, 'ArrowLeft', 2);
  await waitForOverlay(page, 'p01-basic');
  expect((await overlaidTexts(page, 'p07-spread')).length, '翻到 p01 後還看得到 p07 的譯文').toBe(0);
  expect((await overlaidTexts(page, 'p08-action')).length, '翻到 p01 後還看得到 p08 的譯文').toBe(0);

  // 翻回來：p08 畫進又一張 img，從記住的結果重新覆蓋
  await turnTo(page, 'ArrowRight', 1);
  await waitForOverlay(page, 'p08-action');
  expect((await overlaidTexts(page, 'p01-basic')).length, '翻回 p08 後還看得到 p01 的譯文').toBe(0);
  expect((await overlaidTexts(page, 'p07-spread')).length, '翻回 p08 後還看得到 p07 的譯文').toBe(0);
  await expectAligned(page, 'p08-action', '翻回來後');
});

/** 仿電子書閱讀器工具列上的文字（browser/mock-site/ebook-reader.ts）：截到工具列的話 OCR 會讀到。 */
const TOOLBAR_TEXTS = ['ライブラリ', 'サンプル作品', '期間限定', '無料試し読み', 'ページ'];

/** 送進 LLM 的原文（= OCR 讀到的）裡有沒有工具列上的文字。 */
async function toolbarTextsSent(sw: Worker): Promise<string[]> {
  const sent = await sentOriginals(sw);
  return TOOLBAR_TEXTS.filter((t) => sent.some((s) => normalize(s).includes(normalize(t))));
}

/** 點畫面中間（仿電子書閱讀器的感應層）切換工具列。 */
async function toggleToolbar(page: Page): Promise<void> {
  const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  await page.mouse.click(size.width / 2, size.height / 2);
}

const captureCount = (sw: Worker) => sw.evaluate(() => globalThis.__captureLog?.length ?? 0);

for (const bg of ['black', 'white'] as const) {
  test(`#59 工具列蓋住頁面（${bg === 'black' ? '黑底' : '白底'}）：開著也翻，截圖前藏起工具列，譯文落在 Balloon 內`, async ({ context, sw, extensionId, mockSite }) => {
    const url = `${mockSite.ebookReaderUrl}?toolbar=shown&bg=${bg}`;
    const { page, panel } = await activateOnMockSite({ context, sw, extensionId, mockSite, url });

    await waitForOverlay(page, 'p07-spread');
    await expectAligned(page, 'p07-spread', `工具列開著（${bg}）`);
    expect(await page.locator('#chrome').evaluate((el) => !el.classList.contains('hidden'))).toBe(true);
    // 截到的 Page 裡沒有工具列：OCR 沒讀到工具列上的字
    expect(await toolbarTextsSent(sw)).toEqual([]);
    // #55 的遮擋提示拿掉了
    await expect(panel.getByText('擋住')).toHaveCount(0);
  });
}

test('#55 工具列開了又收起：同一頁命中快取、不重翻', { tag: '@e2e' }, async ({ context, sw, extensionId, mockSite }) => {
  const { page } = await activateOnMockSite({ context, sw, extensionId, mockSite, url: mockSite.ebookReaderUrl });
  await waitForOverlay(page, 'p07-spread');
  await expect.poll(() => sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(2);

  // 點擊會觸發掃描：工具列開著時截的圖（藏起工具列）跟收起時一樣，hash 認得出同一頁
  const captures = await captureCount(sw);
  await toggleToolbar(page);
  await expect.poll(() => captureCount(sw)).toBeGreaterThan(captures);
  await toggleToolbar(page);
  await page.locator('#chrome.hidden').waitFor({ state: 'attached' });
  await waitForOverlay(page, 'p07-spread');
  await expectAligned(page, 'p07-spread', '工具列收起後');
  expect(await sw.evaluate(() => globalThis.__translateCalls ?? 0)).toBe(2);
  expect(await toolbarTextsSent(sw)).toEqual([]);
});
