/// <reference types="vite/client" />
/**
 * 首頁的互動展示（#109）：假的 Chrome 視窗裡放 Practice Spread 的右頁，點工具列的 Naruhodo 圖示後 side panel 滑出來，再點一次就收回去（跟外掛一樣是開關）。
 * side panel 是外掛的 SidePanel（render 在 shadow root 裡，樣式跟外掛同一份），頁面上的譯文與 tooltip 是外掛的
 * createOverlay；這裡只負責假外框與「辨識中 → 翻譯中 → 完成」的計時（demo-state.ts），資料是事先錄好的 demo-page.json。
 * 外掛介面只有繁體中文，所以展示裡面維持中文；只有外框上的提示（copy）跟著網站語言。
 */
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createOverlay, type Overlay } from '../../../src/content/overlay.ts';
import logoSrc from '../../../src/icons/naruhodo-small.svg?url';
import type { LineRef } from '../../../src/shared/messages.ts';
import type { PageMode } from '../../../src/shared/page-mode.ts';
import TOKENS from '../../../src/shared/tokens.css';
import COMPONENTS from '../../../src/ui/components.css';
import SIDE_PANEL from '../../../src/ui/side-panel.css';
import { SidePanel } from '../../../src/ui/index.ts';
import spreadSrc from '../../../practice-spread/practice-spread.webp?url';
import { demoPages } from './demo-page.ts';
import { clickIcon, demoView, nextPhase, type DemoPhase } from './demo-state.ts';

/**
 * shadow root 裡的樣式：host 不繼承網站的字型與顏色（all: initial），side panel 的 tokens 與元件樣式跟外掛同一份。
 * host 本身是 side panel 的捲動區（外掛裡是整個 side panel 視窗）。
 */
const PANEL_STYLE = `${TOKENS}${COMPONENTS}${SIDE_PANEL}
:host { all: initial; display: block; overflow-y: auto; background: var(--naru-surface); }`;

const noop = () => {};

export interface DemoCopy {
  /** 圖示旁的提示 */
  hint: string;
}

export function Demo({ copy }: { copy: DemoCopy }) {
  const [phase, setPhase] = useState<DemoPhase>('closed');
  const [pageMode, setPageMode] = useState<PageMode>('read');
  const [hovered, setHovered] = useState<LineRef | undefined>(undefined);
  const image = useRef<HTMLImageElement>(null);
  const panelHost = useRef<HTMLDivElement>(null);
  const panelMount = useRef<HTMLElement>(undefined);
  const overlay = useRef<Overlay>(undefined);
  const view = demoView(phase, demoPages);

  // 辨識中 → 翻譯中 → 完成
  useEffect(() => {
    const step = nextPhase(phase);
    if (!step) return;
    const timer = setTimeout(() => setPhase(step.phase), step.afterMs);
    return () => clearTimeout(timer);
  }, [phase]);

  // 翻完才畫覆蓋層；停止（再點一次圖示）就整個拿掉
  useEffect(() => {
    const img = image.current;
    if (!view.overlay || !img) return;
    const created = createOverlay({ onHover: (line) => setHovered(line ?? undefined) });
    created.setPageMode(pageMode);
    overlay.current = created;
    // 圖是整張跨頁，跟外掛一樣用 sub 只蓋右半張
    void img.decode().then(() => Promise.all(demoPages.map((page) => created.show(img, page.sub, page.text, page.pageHash))));
    return () => {
      created.clear();
      overlay.current = undefined;
      setHovered(undefined);
    };
    // pageMode 由下一個 effect 同步，不重畫覆蓋層
  }, [view.overlay]);

  useEffect(() => overlay.current?.setPageMode(pageMode), [pageMode]);

  // SidePanel render 在 shadow root 裡：網站的樣式進不去，side panel 的樣式也不會漏出來
  useEffect(() => {
    const host = panelHost.current!;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_STYLE;
    const mount = document.createElement('div');
    root.replaceChildren(style, mount);
    panelMount.current = mount;
    return () => render(null, mount);
  }, []);

  useEffect(() => {
    const mount = panelMount.current;
    if (!mount) return;
    if (!view.panelOpen) {
      render(null, mount);
      return;
    }
    render(
      <SidePanel
        running={view.running}
        pages={view.pages}
        modelStatus={{ state: 'idle' }}
        access={{ mode: 'hosted', signedIn: true }}
        consented
        pageMode={pageMode}
        hovered={hovered}
        logoSrc={logoSrc}
        onPageModeChange={setPageMode}
        onScan={noop}
        onTranslate={noop}
        onRetranslate={noop}
        onLineHover={(line) => overlay.current?.highlight(line)}
        onAcceptConsent={noop}
        onUseOwnKey={noop}
        onSignIn={noop}
        quota={{ plan: 'free', remaining: view.remaining }}
      />,
      mount,
    );
  });

  const scanning = phase === 'recognizing' || phase === 'translating';
  return (
    <div class={`demo-chrome${view.panelOpen ? ' is-open' : ''}`}>
      <div class="demo-chrome__tabs" aria-hidden="true">
        <span class="demo-chrome__dots">
          <i />
          <i />
          <i />
        </span>
        <span class="demo-chrome__tab">
          <span class="demo-chrome__favicon" />
          第12話 ｜ Sample Manga
        </span>
      </div>
      <div class="demo-chrome__bar">
        <span class="demo-chrome__nav" aria-hidden="true">
          ← → ↻
        </span>
        <span class="demo-chrome__url">manga.example.com/sample-series/chapter-12</span>
        <button
          type="button"
          class={`demo-chrome__ext${view.running ? '' : ' is-pulsing'}`}
          aria-label="Naruhodo"
          aria-pressed={view.running}
          onClick={() => setPhase(clickIcon)}
        >
          <img src={logoSrc} alt="" width={20} height={20} />
          {!view.running && <span class="demo-chrome__hint">{copy.hint}</span>}
        </button>
      </div>
      <div class="demo-chrome__body">
        <div class="demo-chrome__page">
          <div class="demo-chrome__manga">
            <img ref={image} src={spreadSrc} width={2000} height={1342} alt="" />
            {/* 辨識中：對話框上的提示（外掛在辨識時頁面上不畫東西，這是展示自己的效果） */}
            {scanning &&
              // 展示框剛好框住這一頁，balloonBbox（對 Page 的比例）直接當位置
              demoPages.flatMap(({ pageHash, text }) =>
                text.balloons.map((b) => (
                  <span
                    key={`${pageHash}:${b.id}`}
                    class="demo-scan"
                    style={{ left: `${b.balloonBbox.x * 100}%`, top: `${b.balloonBbox.y * 100}%`, width: `${b.balloonBbox.w * 100}%`, height: `${b.balloonBbox.h * 100}%` }}
                  />
                )),
              )}
          </div>
        </div>
        <div class="demo-chrome__drawer">
          <div class="demo-chrome__panel" ref={panelHost} />
        </div>
      </div>
    </div>
  );
}
