// e2e build 才有（#108）：證明產品網站能直接重用外掛的畫面（browser/ui-reuse.spec.ts）。
// 打包成傳統 script，測試注入到一般網頁（不是外掛頁面、沒有 chrome.runtime），做網站會做的事：
// 在 shadow root 裡載入 tokens 與元件樣式再 render SidePanel；對一個 <img> 呼叫 createOverlay。
import { render } from 'preact';
import type { LineRef, PageView } from '../shared/messages.ts';
import type { PageMode } from '../shared/page-mode.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import TOKENS from '../shared/tokens.css';
import CONTAINER from '../sidepanel/sidepanel.css';
import COMPONENTS from '../ui/components.css';
import SIDE_PANEL from '../ui/side-panel.css';
import { SidePanel } from '../ui/index.ts';
import { createOverlay, type Overlay } from '../content/overlay.ts';

/** 每個元素看得到的樣式（不含跟視窗寬度有關的尺寸）。 */
export type StyleSnapshot = { tag: string; class: string; style: Record<string, string> }[];

const PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'display', 'position',
  'flex-direction', 'gap', 'margin', 'padding', 'border', 'border-radius', 'box-shadow', 'list-style-type', 'text-decoration-line',
];

function snapshot(elements: Element[]): StyleSnapshot {
  return elements.map((element) => {
    const computed = getComputedStyle(element);
    return {
      tag: element.localName,
      class: element.getAttribute('class') ?? '',
      style: Object.fromEntries(PROPERTIES.map((p) => [p, computed.getPropertyValue(p)])),
    };
  });
}

const style = (css: string) => Object.assign(document.createElement('style'), { textContent: css });

/** 網頁自己的元素：跟 side panel 用同樣的標籤與屬性，樣式漏出來就會變。 */
const PROBE = '<main><ul aria-label="Page"><li lang="ja">probe</li></ul><input /><select></select></main><footer>probe</footer>';

export interface TestUi {
  /** shadow：像網站那樣放進 shadow root；否則像外掛的 sidepanel.html 那樣把樣式載入整頁。回傳 side panel 每個元素的樣式。 */
  renderSidePanel(input: { shadow: boolean; pages: PageView[]; hovered: LineRef }): StyleSnapshot;
  /** 網頁自己的元素的樣式，與 :root 上的 tokens。 */
  pageStyles(): { tokens: string; elements: StyleSnapshot };
  renderOverlay(input: { image: string; pages: { sub: RatioRect; text: PageText }[]; pageMode: PageMode }): Promise<void>;
}

let overlay: Overlay | undefined;

globalThis.__testUi = {
  renderSidePanel({ shadow, pages, hovered }) {
    const mount = document.createElement('div');
    // 兩邊同寬（像 side panel），margin: auto 之類算出來的值才會一樣
    const width = '360px';
    if (shadow) {
      const host = document.createElement('div');
      host.style.width = width;
      document.body.append(host);
      const root = host.attachShadow({ mode: 'open' });
      root.append(style(TOKENS + COMPONENTS + SIDE_PANEL), mount);
    } else {
      document.head.append(style(TOKENS + COMPONENTS + SIDE_PANEL + CONTAINER));
      mount.style.width = width;
      document.body.append(mount);
    }
    const noop = () => {};
    render(
      <SidePanel
        running
        pages={pages}
        modelStatus={{ state: 'idle' }}
        access={{ mode: 'ownKey', hasKey: true }}
        consented
        pageMode="read"
        hovered={hovered}
        logoSrc=""
        onPageModeChange={noop}
        onScan={noop}
        onTranslate={noop}
        onRetranslate={noop}
        onLineHover={noop}
        onAcceptConsent={noop}
        onUseOwnKey={noop}
        onSignIn={noop}
      />,
      mount,
    );
    const root = mount.querySelector('.naru-side-panel')!;
    return snapshot([root, ...root.querySelectorAll('*')]);
  },

  pageStyles() {
    let probe = document.getElementById('probe');
    if (!probe) {
      probe = Object.assign(document.createElement('div'), { id: 'probe', innerHTML: PROBE });
      document.body.prepend(probe);
    }
    const tokens = getComputedStyle(document.documentElement).getPropertyValue('--naru-ink');
    return { tokens, elements: snapshot([document.documentElement, document.body, ...probe.querySelectorAll('*')]) };
  },

  async renderOverlay({ image, pages, pageMode }) {
    overlay?.clear();
    // 網站自己決定字型怎麼載入；這裡用系統字型
    overlay = createOverlay();
    overlay.setPageMode(pageMode);
    const img = document.createElement('img');
    img.src = image;
    img.style.width = '430px';
    document.body.replaceChildren(img);
    await img.decode();
    for (const { sub, text } of pages) await overlay.show(img, sub, text);
  },
};

declare global {
  var __testUi: TestUi;
}
