/**
 * side panel 的純畫面（#108）：只吃「現在要顯示什麼」與一組 callback，不碰 chrome.*、IndexedDB 或任何 store，
 * 外掛（src/sidepanel/main.tsx 的 container）與產品網站都 render 這一個。樣式在 side-panel.css，
 * 全部以根元素 .naru-side-panel 為範圍，放進 shadow root（再載入 tokens.css、components.css）就完整。
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { Quota } from '../shared/hosted-api.ts';
import type { LineRef, ModelStatus, PageView } from '../shared/messages.ts';
import type { PageMode } from '../shared/page-mode.ts';
import type { StaleReason } from '../shared/series-notes.ts';
import { Badge, Button, Callout, PageHeader, Progress, SegmentedControl, type SegmentOption } from './components.tsx';
import { OwnKeyDataFlow } from './data-flow.tsx';
import { PRIVACY_URL } from './links.ts';
import { PaymentUnavailable, SubscribeButton } from './subscribe-button.tsx';
import { DEFAULT_LEVEL, DisplaySwitch, Transcript, type Display, type Level } from './transcript.tsx';
import {
  quotaView,
  setupNotices,
  parentPage,
  sidePanelScreen,
  sidePanelView,
  type OverallStatus,
  type PanelPage,
  type PageEntry,
  type QuotaView,
  type SetupNotice,
  type TranslationAccess,
} from './view.ts';

const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(1);

function ModelStatusLine({ status, onRetry }: { status: ModelStatus; onRetry: () => void }) {
  switch (status.state) {
    case 'downloading':
      return (
        <p role="status">
          第一次使用，下載辨識模型中：{mb(status.loaded)} / {mb(status.total)} MB
          <progress value={status.loaded} max={status.total} />
        </p>
      );
    case 'loading':
      return <p role="status">載入辨識模型中…</p>;
    case 'error':
      return (
        <Callout tone="danger" role="alert">
          <p>辨識模型無法使用：{status.message}</p>
          <Button onClick={onRetry}>重試</Button>
        </Callout>
      );
    default:
      return null;
  }
}

/** 逐字稿的共用狀態：依 Page Mode 的顯示方式（#76）與 hover 同步（#39）。 */
interface TranscriptSync {
  display: Display;
  /** 頁面上滑鼠所在的那句。 */
  hovered: LineRef | undefined;
  /** 滑過 panel 的某行 → 頁面上那句高亮；null＝離開。 */
  onLineHover: (line: LineRef | null) => void;
}

const STALE_TEXT: Record<StaleReason, string> = {
  notes: 'Series Notes 已更新，這頁是用舊筆記翻的',
  version: '翻譯模型或 prompt 已更新，這頁是用舊版翻的',
};

/** 過時只提示、不自動重翻（spec #27 第 4.3 節）；按「重新翻譯」只重翻這一頁。 */
function StaleHint({ reason, onRetranslate }: { reason: StaleReason; onRetranslate: () => void }) {
  return (
    <Callout tone="warn" role="group" aria-label="過時提示">
      <span>{STALE_TEXT[reason]}</span>
      <Button onClick={onRetranslate}>重新翻譯</Button>
    </Callout>
  );
}

function PageItem({
  entry: { page, side, heading, translationStatus },
  onRetry,
  onRetranslate,
  sync,
}: {
  entry: PageEntry;
  onRetry: () => void;
  onRetranslate: () => void;
  sync: TranscriptSync;
}) {
  const { transcript } = page;
  const { display, hovered, onLineHover } = sync;
  const headingId = useId();
  return (
    <li aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        side={side}
        heading={heading}
        status={
          translationStatus && (
            <p class="translation-status" role="status" aria-label="翻譯狀態">
              {translationStatus}
            </p>
          )
        }
      />
      {transcript.state === 'analyzing' && <Progress>辨識中…</Progress>}
      {transcript.state === 'pending' && <Callout>未翻譯（自動翻譯已關閉，按「翻譯此頁」）</Callout>}
      {transcript.state === 'error' && <Callout tone="danger">辨識失敗：{transcript.message}</Callout>}
      {transcript.state === 'done' && transcript.stale && !transcript.translating && (
        <StaleHint reason={transcript.stale} onRetranslate={onRetranslate} />
      )}
      {transcript.state === 'done' && transcript.translating && <Progress>翻譯中…</Progress>}
      {transcript.state === 'done' && transcript.translateError && (
        <Callout tone="danger" role="alert">
          <p>翻譯失敗，改顯示 kuromoji 讀音：{transcript.translateError}</p>
          <Button onClick={onRetry}>重試</Button>
        </Callout>
      )}
      {transcript.state === 'done' && (
        <Transcript
          text={transcript.text}
          translated={transcript.translated}
          display={display}
          hoveredId={hovered?.pageHash === page.pageHash ? hovered.lineId : undefined}
          onHover={(lineId) => onLineHover(lineId === null ? null : { pageHash: page.pageHash, lineId })}
        />
      )}
    </li>
  );
}

/**
 * 自備金鑰的資料使用說明（shared/data-consent.ts）：還沒同意就固定顯示在最上面，啟動前、從內建選單打開時都一樣。
 * 文字在 data-flow.tsx（跟 onboarding 的「使用自備金鑰」同一份）。按了「同意並啟用翻譯」，已啟動的分頁直接開始翻譯（SW）。
 */
function DataConsentCard({ onAccept }: { onAccept: () => void }) {
  return (
    <section aria-label="資料使用說明">
      <Callout tone="warn">
        <p>
          <strong>翻譯前請先確認資料怎麼使用</strong>
        </p>
        <OwnKeyDataFlow />
        <p>
          詳見
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            隱私權政策
          </a>
          。不同意也能使用，只會顯示原文與讀音。
        </p>
        <Button variant="primary" onClick={onAccept}>
          同意並啟用翻譯
        </Button>
      </Callout>
    </section>
  );
}

/**
 * 逐字稿上方的設定提示（view.ts 的 setupNotices 決定顯示哪一個）。「尚未登入」的版面與文案照 #91 畫面定案、
 * 內建翻譯提示照 #93：「登入」「改用內建翻譯」打開 onboarding 的第 2 步，「使用自備金鑰」打開設定頁。
 */
function SetupNoticeCallout({
  notice,
  onSignIn,
  onUseOwnKey,
  onDismissHostedHint,
}: {
  notice: SetupNotice;
  onSignIn: () => void;
  onUseOwnKey: () => void;
  onDismissHostedHint: () => void;
}) {
  if (notice === 'noKey')
    return <Callout tone="warn">尚未設定 API key：只顯示原文與讀音（kuromoji 推測），未翻譯。請在 ⚙ 選單的「設定」輸入 key。</Callout>;
  if (notice === 'hostedHint')
    return (
      <Callout class="naru-callout--stack" role="group" aria-label="內建翻譯提示">
        <p>現在也可以改用內建翻譯：用 email 登入就能翻，不用自備 API key。新帳號有 50 頁免費額度。</p>
        <div class="naru-row">
          {/* 按任何一個都算關掉，不再出現 */}
          <Button
            onClick={() => {
              onDismissHostedHint();
              onSignIn();
            }}
          >
            改用內建翻譯
          </Button>
          <Button variant="ghost" onClick={onDismissHostedHint}>
            不用了
          </Button>
        </div>
      </Callout>
    );
  if (notice !== 'signedOut') return null;
  return (
    <Callout tone="warn" class="naru-callout--stack" role="group" aria-label="尚未登入">
      <p>
        <strong>尚未登入</strong>：只顯示原文與讀音。
      </p>
      <div class="naru-row">
        <Button variant="primary" onClick={onSignIn}>
          登入
        </Button>
        <Button variant="link" onClick={onUseOwnKey}>
          使用自備金鑰
        </Button>
      </div>
    </Callout>
  );
}

/**
 * 額度用完（#92、#94 畫面定案）：逐字稿上方的 warn Callout。已翻過的頁照常顯示快取的譯文，新的頁只有原文與讀音。
 * 免費額度用完有「訂閱」；本月額度用完只有「使用自備金鑰」（等重置）。
 */
function QuotaExhaustedCallout({
  exhausted,
  onSubscribe,
  onUseOwnKey,
}: {
  exhausted: NonNullable<QuotaView['exhausted']>;
  onSubscribe: (() => void) | undefined;
  onUseOwnKey: () => void;
}) {
  return (
    <Callout tone="warn" class="naru-callout--stack" role="group" aria-label="額度已用完">
      <p>
        <strong>{exhausted.title}</strong>
      </p>
      <p>{exhausted.body}</p>
      <div class="naru-row">
        {exhausted.subscribe && <SubscribeButton variant="primary" onSubscribe={onSubscribe} />}
        <Button variant="link" onClick={onUseOwnKey}>
          使用自備金鑰
        </Button>
      </div>
    </Callout>
  );
}

/** 底部狀態列裡剩餘頁數那一行（系列與翻譯狀態之間）；剩 5 頁以下用警告色。 */
function QuotaLine({ line, onSubscribe }: { line: NonNullable<QuotaView['line']>; onSubscribe: (() => void) | undefined }) {
  return (
    <div role="status" aria-label="剩餘額度" class={`status-row quota-row${line.warn ? ' quota-row--warn' : ''}`}>
      <span>{line.text}</span>
      {line.subscribeLink && <SubscribeButton variant="link" onSubscribe={onSubscribe} />}
    </div>
  );
}

/** 底部狀態列（spec #27 第 8 節），文字由 view.ts 算好。 */
function StatusText({ status }: { status: OverallStatus }) {
  if (status?.kind === 'translating') return <Progress>翻譯中…</Progress>;
  return status ? <span>{status.text}</span> : null;
}

const PAGE_MODES: readonly SegmentOption<PageMode>[] = [
  { value: 'read', label: '閱讀', description: '頁面直接顯示中文' },
  { value: 'learn', label: '學習', description: '保留日文，滑過看讀音' },
];

/**
 * Page Mode 切換（spec #70、#73）：全域設定，外掛存在 chrome.storage.local；頁面上的 content script 自己聽變更。
 * 學習時頁面不擦字、不畫譯文，翻譯照常進行。
 */
function PageModeSwitch({ mode, choose }: { mode: PageMode; choose: (mode: PageMode) => void }) {
  return <SegmentedControl label="頁面模式" size="lg" options={PAGE_MODES} value={mode} onChange={choose} />;
}

/** 標題：logo（跟外掛 icon 同一份 SVG 母檔）＋名稱。 */
function Title({ logoSrc }: { logoSrc: string }) {
  return (
    <h1 class="title">
      <img src={logoSrc} alt="" width={24} height={24} />
      Naruhodo
    </h1>
  );
}

/** 齒輪圖示（⚙ 選單）。 */
function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/** ⚙ 選單的一項；說明不算進按鈕的 accessible name（同 SegmentedControl 的副標）。 */
function MenuItem({ label, description, onClick }: { label: string; description?: string; onClick: () => void }) {
  const id = useId();
  return (
    <button type="button" class="panel-menu__item" aria-describedby={description ? id : undefined} onClick={onClick}>
      <span>{label}</span>
      {description && (
        <span id={id} class="panel-menu__desc" aria-hidden="true">
          {description}
        </span>
      )}
    </button>
  );
}

/**
 * 頂部的 ⚙ 選單（spec #70、#77）：不常用的功能收在這裡。點外面或按 Esc 收起；按了一項（開關以外）也收起。
 * 沒有啟動的 tab 時只有「設定」。container 沒給的頁（網站上）就沒有那一項。
 */
function PanelMenu({
  running,
  autoTranslate,
  sections,
  onScan,
  onOpen,
}: {
  running: boolean;
  autoTranslate: ComponentChildren;
  sections: Record<MenuPage, boolean>;
  onScan: () => void;
  onOpen: (page: MenuPage) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    // 用 composedPath：在 shadow root 裡（網站），document 收到的 target 是 shadow host
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current || !e.composedPath().includes(root.current)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    // 焦點在 ⚙ 或選單裡時按 Esc 收起
    <div class="panel-menu" ref={root} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <Button variant="icon" aria-label="設定" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
        <GearIcon />
      </Button>
      {open && (
        <div id={menuId} role="group" aria-label="設定選單" class="panel-menu__popover">
          {running && (
            <>
              {autoTranslate && <div class="panel-menu__switch">{autoTranslate}</div>}
              {/* 翻頁會自動偵測（#34）；這項給偵測漏掉時手動補一次。 */}
              <MenuItem label="重新擷取頁面" description="翻頁沒被偵測到時用" onClick={choose(onScan)} />
              {sections.notes && <MenuItem label="Series Notes" onClick={choose(() => onOpen('notes'))} />}
            </>
          )}
          {sections.settings && <MenuItem label="設定" onClick={choose(() => onOpen('settings'))} />}
        </div>
      )}
    </div>
  );
}

export interface SidePanelProps {
  /** 有已啟動的 tab：顯示 Page Mode 與逐字稿；false＝只顯示「請點外掛圖示啟動」。 */
  running: boolean;
  pages: PageView[];
  modelStatus: ModelStatus;
  /** 翻譯模式與能不能翻（內建翻譯有沒有登入、自備金鑰有沒有 key）；不能翻時顯示提示。 */
  access: TranslationAccess;
  /** 資料使用同意；自備金鑰時 false＝顯示說明卡，undefined＝還在讀（不顯示）。內建翻譯的同意在登入時取得。 */
  consented: boolean | undefined;
  pageMode: PageMode;
  /** 頁面上滑鼠所在的那句（逐字稿那行高亮）。 */
  hovered: LineRef | undefined;
  /** 標題旁的 logo（外掛是 icons/naruhodo.svg）。 */
  logoSrc: string;
  onPageModeChange: (mode: PageMode) => void;
  onStop: () => void;
  /** 重新擷取頁面（⚙ 選單、模型錯誤的「重試」）。 */
  onScan: () => void;
  /** 翻譯這個 tab 的頁；給 pageHash 就只重翻那一頁。 */
  onTranslate: (pageHash?: string) => void;
  /** 滑過逐字稿的某行；null＝離開。 */
  onLineHover: (line: LineRef | null) => void;
  onAcceptConsent: () => void;
  /** 「尚未登入」與額度用完的「使用自備金鑰」：切到自備金鑰（設定頁同時打開）。 */
  onUseOwnKey: () => void;
  /** 「登入」「改用內建翻譯」：外掛打開 onboarding 的第 2 步（同意並登入）。 */
  onSignIn: () => void;
  /** onboarding 做完了沒（#93）；false＝只顯示「完成設定」。沒給＝完成（網站上）。 */
  setupComplete?: boolean;
  /** 「完成設定」：打開 onboarding，回到停下來的那一步。 */
  onFinishSetup?: () => void;
  /** 從舊版更新、仍用自備金鑰：顯示一次「現在也可以改用內建翻譯」。 */
  hostedHint?: boolean;
  /** 內建翻譯提示的任何一個按鈕：記下已經關掉。 */
  onDismissHostedHint?: () => void;
  /** 內建翻譯的剩餘額度（Worker 的 GET /v1/account）；undefined＝還在讀、沒登入或自備金鑰。 */
  quota?: Quota;
  /** 「訂閱」：外掛建立 Paddle checkout、用新分頁打開（#94）；沒給時（網站上的展示）訂閱按鈕停用。 */
  onSubscribe?: () => void;
  /** 上一次按「訂閱」沒能打開 checkout：顯示付款服務暫時無法使用（#156）。 */
  paymentFailed?: boolean;
  /** 以下是只有外掛 container 才有的區塊（會讀寫 store、送 chrome 訊息）；沒給就不顯示，⚙ 選單也沒有那一項。 */
  /** ⚙ 選單裡的自動翻譯開關。 */
  autoTranslate?: ComponentChildren;
  /** 底部列的系列。 */
  series?: ComponentChildren;
  /** 「設定」頁的內容（標題列由 SidePanel 畫）；openDeleteAccount 換到「刪除帳號」那一頁。 */
  renderSettings?: (close: () => void, openDeleteAccount: () => void) => ComponentChildren;
  /** 「刪除帳號」頁的內容（#95）；back 回到設定頁（「取消」、刪除成功）。 */
  renderDeleteAccount?: (back: () => void) => ComponentChildren;
  /** 「Series Notes」頁的內容。 */
  renderNotes?: (close: () => void) => ComponentChildren;
}

/** 沒做完 onboarding（#93 畫面定案）：只有置中的大 logo、名稱、「設定還沒完成」與「完成設定」，沒有頂部的狀態與 ⚙。 */
function FinishSetup({ logoSrc, onFinishSetup }: { logoSrc: string; onFinishSetup: (() => void) | undefined }) {
  return (
    <div class="naru-side-panel">
      <main class="finish-setup">
        <img src={logoSrc} alt="" width={48} height={48} />
        <h1>Naruhodo</h1>
        <p>設定還沒完成</p>
        <Button variant="primary" onClick={onFinishSetup}>
          完成設定
        </Button>
      </main>
    </div>
  );
}

const PAGE_TITLES: Record<PanelPage, string> = { settings: '設定', notes: 'Series Notes', deleteAccount: '刪除帳號' };

/** ⚙ 選單打得開的頁。 */
type MenuPage = Exclude<PanelPage, 'deleteAccount'>;

/** 從 ⚙ 選單打開的一頁（設定、Series Notes）：整個 side panel 換成它，頂部是「←」＋標題，沒有逐字稿與底部狀態列。 */
function PanelPageView({ title, onBack, children }: { title: string; onBack: () => void; children: ComponentChildren }) {
  return (
    <div class="naru-side-panel">
      <main>
        <div class="panel-header">
          <Button variant="icon" aria-label="返回" onClick={onBack}>
            ←
          </Button>
          <h1 class="title">{title}</h1>
        </div>
        {children}
      </main>
    </div>
  );
}

export function SidePanel(props: SidePanelProps) {
  const { running, pages, modelStatus, access, consented, pageMode, hovered, onScan, onTranslate } = props;
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const [furigana, setFurigana] = useState(true);
  const display: Display = pageMode === 'learn' ? { mode: 'learn', furigana } : { mode: 'read', level };
  const [page, setPage] = useState<PanelPage | undefined>(undefined);

  const close = () => setPage(undefined);
  const screen = sidePanelScreen({ setupComplete: props.setupComplete ?? true, page });
  if (screen === 'finishSetup') return <FinishSetup logoSrc={props.logoSrc} onFinishSetup={props.onFinishSetup} />;
  if (screen !== 'transcript') {
    const back = () => setPage(parentPage(screen));
    const content = {
      settings: () => props.renderSettings?.(close, () => setPage('deleteAccount')),
      notes: () => props.renderNotes?.(close),
      deleteAccount: () => props.renderDeleteAccount?.(back),
    }[screen];
    return (
      <PanelPageView title={PAGE_TITLES[screen]} onBack={back}>
        {content()}
      </PanelPageView>
    );
  }
  // 頂部只有 logo、名稱、狀態、停止、⚙（#77）；其餘收進 ⚙ 選單
  const header = (
    <div class="panel-header">
      <Title logoSrc={props.logoSrc} />
      {running && <Badge tone="ok">已啟動</Badge>}
      <span class="panel-header__spacer" />
      {running && (
        <Button variant="ghost" onClick={props.onStop}>
          停止
        </Button>
      )}
      <PanelMenu
        running={running}
        autoTranslate={props.autoTranslate}
        sections={{ notes: Boolean(props.renderNotes), settings: Boolean(props.renderSettings) }}
        onScan={onScan}
        onOpen={setPage}
      />
    </div>
  );
  const done = pages.filter((p) => p.transcript.state === 'done');
  const pending = pages.some((p) => p.transcript.state === 'pending');
  const untranslated = pending || done.some((p) => p.transcript.state === 'done' && !p.transcript.translated);
  const notices = setupNotices({ access, consented, untranslated, hostedHint: props.hostedHint });
  const consentCard = notices.consentCard && <DataConsentCard onAccept={props.onAcceptConsent} />;
  const useOwnKey = () => {
    props.onUseOwnKey();
    setPage('settings');
  };
  if (!running)
    return (
      <div class="naru-side-panel">
        <main>
          {header}
          {consentCard}
          <p>請點外掛圖示啟動</p>
        </main>
      </div>
    );
  const translate = () => onTranslate();
  const view = sidePanelView(pages, access.mode);
  const quota = quotaView(access, props.quota);
  const sync: TranscriptSync = { display, hovered, onLineHover: props.onLineHover };
  return (
    <div class="naru-side-panel">
      <main>
        {header}
        {consentCard}
        <PageModeSwitch mode={pageMode} choose={props.onPageModeChange} />
        <ModelStatusLine status={modelStatus} onRetry={onScan} />
        <SetupNoticeCallout
          notice={notices.notice}
          onSignIn={props.onSignIn}
          onUseOwnKey={useOwnKey}
          onDismissHostedHint={() => props.onDismissHostedHint?.()}
        />
        {quota.exhausted && <QuotaExhaustedCallout exhausted={quota.exhausted} onSubscribe={props.onSubscribe} onUseOwnKey={useOwnKey} />}
        {props.paymentFailed && <PaymentUnavailable />}
        {done.length > 0 && <DisplaySwitch display={display} onLevel={setLevel} onFurigana={setFurigana} />}
        <ul aria-label="Page">
          {view.pages.map((entry) => (
            // 同一個 anchor 可能有兩個 Page（Spread），key 要帶 Page 身分
            <PageItem
              key={`${entry.page.anchorId}/${entry.page.pageHash}`}
              entry={entry}
              onRetry={translate}
              onRetranslate={() => onTranslate(entry.page.pageHash)}
              sync={sync}
            />
          ))}
        </ul>
      </main>
      {/* 底部固定列；放在 main 外面才是 contentinfo landmark。系列一行、內建翻譯的剩餘頁數一行、整體翻譯狀態＋按鈕一行（#77、#92） */}
      <footer aria-label="狀態列">
        {props.series}
        {quota.line && <QuotaLine line={quota.line} onSubscribe={props.onSubscribe} />}
        <div class="status-row">
          <StatusText status={view.status} />
          {quota.footerButton === 'subscribe' ? (
            <SubscribeButton variant="primary" onSubscribe={props.onSubscribe} />
          ) : (
            quota.footerButton === 'translate' &&
            (done.length > 0 || pending) && (
              <Button variant={untranslated ? 'primary' : 'secondary'} onClick={translate}>
                {untranslated ? '翻譯此頁' : '重新翻譯'}
              </Button>
            )
          )}
        </div>
      </footer>
    </div>
  );
}
