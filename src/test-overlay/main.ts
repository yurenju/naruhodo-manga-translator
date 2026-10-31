// e2e build 才有（spec #27 第 12 節第 2 層）：把合成頁的 ground truth 直接畫成覆蓋層，量譯文的 rect（browser/overlay-render.spec.ts）。
// 跟 content script 用同一個 createOverlay 與字型載入器；這裡是外掛頁面，fetch 字型不需要 web_accessible_resources。
import type { Rect } from '../shared/messages.ts';
import type { PageMode } from '../shared/page-mode.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { createOverlay, type Overlay } from '../content/overlay.ts';
import { createOverlayFontLoader } from '../content/overlay-font.ts';

declare global {
  var __renderOverlay: (input: { image: string; width: number; pages: { sub: RatioRect; text: PageText }[]; pageMode?: PageMode }) => Promise<void>;
  /** 截圖前後（hide／restore）；long＝這張圖當成長 Page（擦除與譯文不藏）。 */
  var __overlayCapture: (phase: 'hide' | 'restore', long: boolean) => Promise<void>;
  /** 長 Page 算橫條指紋時要避開的範圍（content script 帶進 PageCandidate.covered 的）。 */
  var __overlayCovered: () => Rect[];
}

const loadFont = createOverlayFontLoader();
let overlay: Overlay | undefined;

globalThis.__renderOverlay = async ({ image, width, pages, pageMode = 'read' }) => {
  overlay?.clear();
  overlay = createOverlay({ loadFont });
  overlay.setPageMode(pageMode);
  // 父元素是 static：跟仿 canvas 網站一樣會被改成 relative
  const slot = document.createElement('div');
  slot.className = 'slot';
  const img = document.createElement('img');
  img.style.width = `${width}px`;
  img.src = image;
  slot.append(img);
  document.body.replaceChildren(slot);
  await img.decode();
  for (const { sub, text } of pages) await overlay.show(img, sub, text);
};

const anchor = () => document.querySelector<HTMLImageElement>('.slot > img')!;

globalThis.__overlayCapture = async (phase, long) => {
  if (phase === 'hide') await overlay!.hideForCapture(long ? new Set([anchor()]) : undefined);
  else overlay!.restoreAfterCapture();
};

globalThis.__overlayCovered = () => overlay!.coveredRects(anchor());
