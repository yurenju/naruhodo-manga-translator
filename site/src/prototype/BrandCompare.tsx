/// <reference types="vite/client" />
/**
 * PROTOTYPE（prototype/brand-yellow，#187）：外掛畫面的主色比較，四欄並排（現況／A／B／C）。
 * 每一格都是 shadow root，載入跟外掛同一份 tokens 與元件樣式，再加上 brand-prototype 的覆寫；欄的 data-variant 決定版本。
 * side panel 是真的 SidePanel（資料借首頁展示的 demo-page），onboarding 與 tooltip 是照外掛 class 拼的樣本。
 */
import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { STYLE as OVERLAY_STYLE } from '../../../src/content/overlay.ts';
import logoSrc from '../../../src/icons/naruhodo-small.svg?url';
import type { PageMode } from '../../../src/shared/page-mode.ts';
import { BRAND_PROTOTYPE_SHADOW } from '../../../src/shared/brand-prototype.ts';
import TOKENS from '../../../src/shared/tokens.css';
import COMPONENTS from '../../../src/ui/components.css';
import SIDE_PANEL from '../../../src/ui/side-panel.css';
import ONBOARDING from '../../../src/onboarding/onboarding.css';
import { Badge, Button, RadioCard, SegmentedControl, SidePanel, Switch } from '../../../src/ui/index.ts';
import { demoPage } from '../demo/demo-page.ts';
import { DEMO_PAGE_HASH, demoView } from '../demo/demo-state.ts';

const VARIANTS = [
  { key: 'now', name: '現況', note: '藍染按鈕＋藍染互動色' },
  { key: 'A', name: 'A', note: '黃按鈕＋墨字；互動色墨色；淡黃底' },
  { key: 'B', name: 'B', note: '黃按鈕＋墨字；互動色藍染；淡黃底' },
  { key: 'C', name: 'C', note: '墨按鈕＋白字；黃色只在 logo 與指示線' },
] as const;

const BASE = `${TOKENS}${BRAND_PROTOTYPE_SHADOW}${COMPONENTS}`;
const PANEL_STYLE = `${BASE}${SIDE_PANEL}
:host { all: initial; display: block; height: 560px; overflow-y: auto; background: var(--naru-surface); border: 1px solid #D0D0D0; }`;
// onboarding.css 的 html, body 規則在 shadow 裡沒作用；底色由 :host 補上
const ONBOARDING_STYLE = `${BASE}${ONBOARDING}
:host { all: initial; display: block; background: var(--naru-surface-2); border: 1px solid #D0D0D0; }
.ob { min-height: 0; padding: var(--naru-space-4); }
.ob-card { padding: var(--naru-space-4); }`;
const TOOLTIP_STYLE = `${OVERLAY_STYLE}
:host { display: block; padding: 12px; background: #FFFFFF; border: 1px solid #D0D0D0; font-size: 15px; }
.tip { position: relative; }`;
const SHEET_STYLE = `${BASE}
:host { all: initial; display: block; padding: 12px; background: var(--naru-surface); border: 1px solid #D0D0D0;
  font-family: var(--naru-font-sans); font-size: var(--naru-text-body); color: var(--naru-ink); }
.stack { display: flex; flex-direction: column; gap: 12px; }
a { color: var(--naru-accent); }`;

/** 把 children render 進 host 的 shadow root；after 在每次 render 後拿到 shadow root（用來點開選單等）。 */
function Shadow({ css, children, after }: { css: string; children: ComponentChildren; after?: (root: ShadowRoot) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    if (!root.firstChild) {
      const style = document.createElement('style');
      style.textContent = css;
      root.append(style, document.createElement('div'));
    }
    render(<>{children}</>, root.lastChild as HTMLElement);
    if (after) setTimeout(() => after(root), 50);
  });
  return <div ref={host} />;
}

const noop = () => {};
const page = demoView('done', demoPage.text);
const firstLine = { pageHash: DEMO_PAGE_HASH, lineId: demoPage.text.balloons[0]!.id };

function Panel({ pageMode, menu }: { pageMode: PageMode; menu?: boolean }) {
  return (
    <Shadow
      css={PANEL_STYLE}
      after={(root) => {
        if (menu) {
          const gear = root.querySelector<HTMLButtonElement>('button[aria-label="設定"]');
          if (gear?.getAttribute('aria-expanded') === 'false') gear.click();
        }
        // 學習模式：讓第一個「譯」區塊呈現揭露後的樣子
        if (pageMode === 'learn') root.querySelector('.naru-reveal')?.dispatchEvent(new MouseEvent('mouseenter'));
      }}
    >
      <SidePanel
        running
        pages={page.pages}
        modelStatus={{ state: 'idle' }}
        access={{ mode: 'hosted', signedIn: true }}
        consented
        pageMode={pageMode}
        hovered={firstLine}
        logoSrc={logoSrc}
        onPageModeChange={noop}
        onStop={noop}
        onScan={noop}
        onTranslate={noop}
        onLineHover={noop}
        onAcceptConsent={noop}
        onUseOwnKey={noop}
        onSignIn={noop}
        quota={{ plan: 'free', remaining: page.remaining }}
      />
    </Shadow>
  );
}

function Onboarding() {
  return (
    <Shadow css={ONBOARDING_STYLE}>
      <div class="ob">
        <div class="ob-brand">
          <img src={logoSrc} alt="" width={24} height={24} />
          Naruhodo
        </div>
        <ol class="ob-dots" aria-label="步驟">
          <li class="done"><span>✓</span>歡迎</li>
          <li class="cur"><span>2</span>登入</li>
          <li><span>3</span>方案</li>
        </ol>
        <div class="ob-card">
          <h2 class="ob-h2">選擇方案</h2>
          <div class="ob-price">免費 50 頁，<a href="#">看看怎麼計算</a></div>
          <div class="ob-plans">
            <section class="ob-plan">
              <p class="ob-plan__name">先用免費額度</p>
              <p class="ob-plan__price">50 頁</p>
              <Button>先用免費額度</Button>
            </section>
            <section class="ob-plan ob-plan--hl">
              <p class="ob-plan__name">訂閱（年繳）</p>
              <p class="ob-plan__price">US$20 / 年</p>
              <Button variant="primary">訂閱</Button>
            </section>
          </div>
          <p style={{ marginTop: 16 }}>
            <Button variant="primary" class="ob-big">下一步</Button>
          </p>
        </div>
      </div>
    </Shadow>
  );
}

function Tooltip() {
  return (
    <Shadow css={TOOLTIP_STYLE}>
      <div class="tip on learn">
        <div class="tip-ja">
          <ruby>今日<rt>きょう</rt></ruby>は<ruby>早<rt>はや</rt></ruby>いね
        </div>
        <div class="tip-reveal">
          <span class="tip-reveal-label">譯</span>
          <span class="tip-reveal-body">滑過這裡看譯文</span>
        </div>
        <div class="tip-reveal on">
          <span class="tip-reveal-label">譯</span>
          <span class="tip-reveal-body">今天真早呢</span>
        </div>
      </div>
    </Shadow>
  );
}

function Sheet() {
  const [seg, setSeg] = useState<'a' | 'b'>('a');
  const [on, setOn] = useState(true);
  return (
    <Shadow css={SHEET_STYLE}>
      <div class="stack">
        <div class="naru-row">
          <Button variant="primary">翻譯這頁</Button>
          <Button>重新擷取</Button>
          <Button variant="ghost">取消</Button>
        </div>
        <SegmentedControl label="顯示" options={[{ value: 'a', label: '原文＋譯文' }, { value: 'b', label: '只看譯文' }]} value={seg} onChange={setSeg} />
        <Switch label="顯示振り仮名" checked={on} onChange={setOn} />
        <RadioCard name="proto" title="內建翻譯" description="用 Naruhodo 帳號的額度" checked onSelect={noop} />
        <div class="naru-row">
          <Badge>一般</Badge>
          <Badge tone="loose">框外文字</Badge>
          <Badge tone="ok">完成</Badge>
        </div>
        <p style={{ margin: 0 }}>
          內文裡的 <a href="#">一個連結</a>，以及 focus 外框：
          <button type="button" class="naru-btn naru-btn--secondary" style={{ outline: '2px solid var(--naru-accent)', outlineOffset: '2px', marginLeft: 8 }}>
            focus 中
          </button>
        </p>
      </div>
    </Shadow>
  );
}

const ROWS: { title: string; render: () => ComponentChildren }[] = [
  { title: 'Side panel：閱讀中（第一句是滑過的狀態）', render: () => <Panel pageMode="read" /> },
  { title: 'Side panel：學習模式（第一個「譯」已揭露）', render: () => <Panel pageMode="learn" /> },
  { title: 'Side panel：⚙ 選單打開', render: () => <Panel pageMode="read" menu /> },
  { title: '元件', render: () => <Sheet /> },
  { title: 'Onboarding', render: () => <Onboarding /> },
  { title: '頁面 tooltip（學習模式）', render: () => <Tooltip /> },
];

export function BrandCompare() {
  return (
    <div class="grid">
      {VARIANTS.map((v) => (
        <div class="head" key={v.key}>
          <strong>{v.name}</strong>
          <span>{v.note}</span>
        </div>
      ))}
      {ROWS.map((row) => (
        <>
          <h2 class="row-title">{row.title}</h2>
          {VARIANTS.map((v) => (
            <div class="cell" key={`${row.title}-${v.key}`} data-variant={v.key === 'now' ? undefined : v.key}>
              {row.render()}
            </div>
          ))}
        </>
      ))}
    </div>
  );
}
