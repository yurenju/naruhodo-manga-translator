/**
 * 翻譯中的外圈（#285）：送出翻譯到譯文蓋上之間，每一句的日文上有一道擦除底色的光帶掃過。
 * unit 測不到的：SW 把送去翻的句子送到 content script、外圈真的畫在那一句的位置上（真實的 DOM 排版）、不擋點擊，
 * 譯文蓋上之後外圈都收掉。哪些句子要畫、錯開的順序在 src/shared/page-outlines.test.ts；什麼時候列出來在 transcribe 的 unit。
 * 等待中的外圈（#283）走同一個訊息與同一段繪製；被切到的框怎麼挑在 long-page 的 unit
 * （FakeEngine 只認得錄過的範圍，捲到一半的那一截重播不出來）。
 */
import type { Page } from '@playwright/test';
import { activateOnMockSite, expect, test } from './fixtures.ts';
import { overlayTexts } from './overlay-helpers.ts';

test.use({ viewport: null, fakeTranslator: true });

interface OutlineBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 外圈中心點底下點到的元素。 */
  hit: string | undefined;
}

declare global {
  interface Window {
    __seenOutlines?: Record<string, OutlineBox>;
  }
}

/**
 * 在頁面裡每個 frame 記下第一個 Page 上出現過的翻譯中外圈（畫面座標）。FakeTranslator 馬上就回，外圈只出現一下子，
 * 從測試這邊輪詢會漏掉。
 */
const recordOutlines = (page: Page) =>
  page.evaluate(() => {
    const seen: Record<string, OutlineBox> = (window.__seenOutlines = {});
    const tick = () => {
      const host = document.querySelector('[data-naruhodo-overlay]');
      for (const el of host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-outline="translating"]') ?? []) {
        const { x, y, width, height } = el.getBoundingClientRect();
        // 截圖時外圈藏著（visibility），那一刻不記
        if (width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        seen[el.dataset.lineId!] ??= { id: el.dataset.lineId!, x, y, width, height, hit: document.elementFromPoint(x + width / 2, y + height / 2)?.tagName };
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const seenOutlines = (page: Page): Promise<OutlineBox[]> => page.evaluate(() => Object.values(window.__seenOutlines ?? {}));
const outlineCount = (page: Page) => page.locator('[data-naruhodo-overlay] [data-outline]').count();

test('翻譯中每一句都有光帶，譯文蓋在同一個位置上，蓋上後光帶都收掉', async ({ context, sw, extensionId, mockSite }) => {
  const { page } = await activateOnMockSite({ context, sw, extensionId, mockSite, beforeActivate: (_panel, page) => recordOutlines(page) });

  await expect.poll(async () => (await seenOutlines(page)).length).toBeGreaterThan(1);
  // 譯文整頁一次蓋上，外圈都收掉
  await expect.poll(async () => (await overlayTexts(page)).length).toBeGreaterThan(0);
  await expect.poll(() => outlineCount(page)).toBe(0);

  const drawn = await seenOutlines(page);
  // 不擋點擊：外圈底下點到的是 Page 本身
  expect(drawn.map((o) => o.hit)).toEqual(drawn.map(() => 'CANVAS'));
  const texts = await overlayTexts(page);
  const covered = drawn.filter((o) => o.id.startsWith('b') && texts.some((t) => t.id === o.id));
  expect(covered.length).toBeGreaterThan(0);
  for (const outline of covered) {
    // 同一個 anchor 上兩頁（Spread）的句子 id 會重複：有一句譯文落在外圈（泡泡外框）裡面就算對上
    const inside = texts.some(
      (t) =>
        t.id === outline.id &&
        t.rect.x >= outline.x - 2 &&
        t.rect.y >= outline.y - 2 &&
        t.rect.x + t.rect.width <= outline.x + outline.width + 2 &&
        t.rect.y + t.rect.height <= outline.y + outline.height + 2,
    );
    expect(inside, `譯文 ${outline.id} 在外圈裡`).toBe(true);
  }
});
