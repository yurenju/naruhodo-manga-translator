import { Fragment, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { indexedDbApiKeyStore, lastFour } from '../shared/api-key-store.ts';
import { grantDataConsent, watchDataConsent, type DataConsent } from '../shared/data-consent.ts';
import type { BackupFile } from '../background/backup.ts';
import type {
  ImportResponse,
  LineRef,
  Message,
  ModelStatus,
  ModelStatusResponse,
  PagesResponse,
  PageView,
  SeriesResponse,
  StatusResponse,
  TestConnectionResponse,
} from '../shared/messages.ts';
import { accountUrl } from '../shared/account-page.ts';
import type { SeriesOption } from '../shared/series.ts';
import { subscribe, useHostedQuota, useHostedSession, usePaymentAction, useTranslationMode } from '../shared/hosted-account-hooks.ts';
import type { Quota } from '../shared/hosted-api.ts';
import type { HostedSession } from '../shared/hosted-session.ts';
import { dismissHostedHint, onboardingUrl, watchHostedHint, watchOnboarding, type OnboardingProgress } from '../shared/onboarding.ts';
import { DEFAULT_PAGE_MODE, savePageMode, watchPageMode, type PageMode } from '../shared/page-mode.ts';
import { dismissSubscribedNotice, watchSubscribedNotice } from '../shared/payment-return.ts';
import { saveTranslationMode, type TranslationMode } from '../shared/translation-mode.ts';
import { Badge, Button, RadioCard } from '../ui/components.tsx';
import { SidePanel, type SeriesPage } from '../ui/side-panel.tsx';
import { accountPlanView, seriesActions } from '../ui/view.ts';
import { ClearCache, SeriesNotesSection } from './series-notes.tsx';

/**
 * 點圖示啟動時，SW 用 sidepanel.html?tabId=N 打開這個 tab 專屬的 side panel。
 * 從 Chrome 內建 side panel 選單打開的沒有 tabId，也沒有 activeTab，只能提示去點圖示。
 */
function readTabId(): number | undefined {
  const raw = new URLSearchParams(location.search).get('tabId');
  return raw === null ? undefined : Number(raw);
}

const send = <R,>(message: Message) => chrome.runtime.sendMessage<Message, R>(message);

const apiKeys = indexedDbApiKeyStore();

/**
 * 匯出／匯入 JSON（#38）：全部 Series、網址模式、Series Notes、翻譯快取，給兩台電腦之間搬資料；不含 API key。
 * 匯入是合併、本機優先。
 */
function Backup() {
  const [result, setResult] = useState<string | undefined>(undefined);

  async function exportFile() {
    const data = await send<BackupFile>({ type: 'panel:export' });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `naruhodo-${new Date(data.exportedAt).toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setResult('匯入失敗：不是 JSON 檔');
      return;
    }
    const r = await send<ImportResponse>({ type: 'panel:import', data });
    setResult(r.ok ? '匯入完成' : `匯入失敗：${r.error}`);
  }

  return (
    <div class="backup">
      <Button onClick={() => void exportFile()}>匯出 JSON</Button>
      <label>
        匯入 JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void importFile(file);
            e.currentTarget.value = '';
          }}
        />
      </label>
      {result && <p role="status">{result}</p>}
    </div>
  );
}

/** 每種翻譯模式的資料使用同意；undefined＝還在讀。 */
function useDataConsent(): DataConsent | undefined {
  const [consent, setConsent] = useState<DataConsent | undefined>(undefined);
  useEffect(() => watchDataConsent(setConsent), []);
  return consent;
}

/** onboarding 的進度；undefined＝還在讀。 */
function useOnboarding(): OnboardingProgress | undefined {
  const [progress, setProgress] = useState<OnboardingProgress | undefined>(undefined);
  useEffect(() => watchOnboarding(setProgress), []);
  return progress;
}

/** 內建翻譯提示還沒關掉（從舊版更新、仍用自備金鑰）。 */
function useHostedHint(): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => watchHostedHint(setShow), []);
  return show;
}

/** side panel 發起的付款確認了、還沒按「知道了」（#176）。 */
function useSubscribedNotice(): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => watchSubscribedNotice(setShow), []);
  return show;
}

/** 用新分頁打開 onboarding（#93）；signIn＝從第 2 步開始。 */
const openOnboarding = (step?: 'signIn') => void chrome.tabs.create({ url: onboardingUrl(step) });

/**
 * 設定頁的帳號摘要（#213）：已登入時是 email＋方案 Badge、剩餘說明與「管理帳號 →」（打開帳號與訂閱頁；訂閱、管理訂閱、登出、刪除帳號都在那裡）；
 * 沒登入時是「登入」，打開 onboarding 的第 2 步。
 */
function HostedAccount({ session, quota }: { session: HostedSession | null; quota: Quota | undefined }) {
  if (!session)
    return (
      <>
        <p>尚未登入。</p>
        <Button variant="primary" onClick={() => openOnboarding('signIn')}>
          登入
        </Button>
      </>
    );
  const plan = quota && accountPlanView(quota);
  return (
    <>
      <p class="naru-row">
        {session.email}
        {plan && <Badge tone={plan.badge.tone}>{plan.badge.text}</Badge>}
      </p>
      {plan && (
        <p class="hint">
          {plan.lines.map((line, i) => (
            <Fragment key={line}>
              {i > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </p>
      )}
      <div class="actions">
        <Button onClick={() => void chrome.tabs.create({ url: accountUrl() })}>管理帳號 →</Button>
      </div>
    </>
  );
}

/**
 * 設定頁「自備金鑰」卡片展開的內容（spec #27 第 5 節）：API key 存在外掛 origin 的 IndexedDB，只顯示末四碼。
 * side panel 自己讀寫 key；「測試連線」由 offscreen 讀 key 呼叫 API，訊息裡不帶 key。
 */
function OwnKey({ onKeyChanged }: { onKeyChanged: (hasKey: boolean) => void }) {
  /** undefined＝還在讀；''＝沒有 key */
  const [suffix, setSuffix] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [connection, setConnection] = useState<string | undefined>(undefined);

  useEffect(() => {
    void apiKeys.get().then((key) => setSuffix(key ? lastFour(key) : ''));
  }, []);

  async function save() {
    const key = draft.trim();
    if (!key) return;
    await apiKeys.set(key);
    setDraft('');
    setConnection(undefined);
    setSuffix(lastFour(key));
    onKeyChanged(true);
  }

  async function remove() {
    await apiKeys.delete();
    setSuffix('');
    setConnection(undefined);
    onKeyChanged(false);
  }

  async function test() {
    setConnection('測試中…');
    const r = await send<TestConnectionResponse>({ type: 'panel:testConnection' });
    setConnection(r.ok ? `連線成功（${r.model}）` : `連線失敗：${r.error}`);
  }

  return (
    <>
      {suffix === undefined ? null : suffix ? (
        <>
          <p>已設定 Claude API key（末四碼 {suffix}）</p>
          <div class="actions">
            <Button onClick={() => void test()}>測試連線</Button>
            <Button onClick={() => void remove()}>刪除</Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Claude API key
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            />
          </label>
          <Button variant="primary" type="submit">
            儲存
          </Button>
        </form>
      )}
      {connection && <p class="connection">{connection}</p>}
      <p class="hint">
        建議在 Anthropic Console 為這個外掛建立專用的 API key，並為它的 workspace 設定花費上限。key 只存在這台電腦的外掛裡，不會交給網頁，也不會出現在匯出檔。
      </p>
    </>
  );
}

/**
 * 設定頁（#93 畫面定案）：按頂部的 ⚙ 打開，整個 side panel 換成這一頁。
 * 翻譯方式是明確的二選一（不會自動切換；切到自備金鑰不會登出），下面是匯出／匯入。
 */
function Settings({
  mode,
  session,
  quota,
  onKeyChanged,
}: {
  mode: TranslationMode;
  session: HostedSession | null;
  quota: Quota | undefined;
  onKeyChanged: (hasKey: boolean) => void;
}) {
  return (
    <section aria-label="設定" class="settings">
      <h2>翻譯方式</h2>
      <div role="radiogroup" aria-label="翻譯方式" class="mode-cards">
        <RadioCard
          name="translation-mode"
          title="內建翻譯"
          description="用 email 帳號，Naruhodo 代為翻譯，有頁數限制"
          checked={mode === 'hosted'}
          onSelect={() => void saveTranslationMode('hosted')}
        >
          <HostedAccount session={session} quota={quota} />
        </RadioCard>
        <RadioCard
          name="translation-mode"
          title="自備金鑰"
          description="用你自己的 Anthropic API key，費用直接付給 Anthropic，沒有頁數限制"
          checked={mode === 'ownKey'}
          onSelect={() => void saveTranslationMode('ownKey')}
        >
          <OwnKey onKeyChanged={onKeyChanged} />
        </RadioCard>
      </div>
      {mode === 'ownKey' && session && (
        // 自備金鑰時內建翻譯的卡片收著：還登入著的帳號另外列出來，才找得到「管理帳號」與登出（#213）
        <>
          <h2>帳號</h2>
          <div class="naru-radio-card">
            <HostedAccount session={session} quota={quota} />
          </div>
          <p class="hint">目前用自備金鑰翻譯，不會用到這個帳號的頁數；切回內建翻譯就能接著用。</p>
        </>
      )}
      <h2>資料</h2>
      <p class="hint">在兩台電腦之間搬作品、角色與用語與翻譯快取（不含 API key 與帳號）。</p>
      <Backup />
    </section>
  );
}

/** 目前的 Page Mode 與切換函式；別的 side panel 切了也跟著變。只在 App 訂閱一次，往下傳。 */
function usePageMode(): [PageMode, (mode: PageMode) => void] {
  const [mode, setMode] = useState<PageMode>(DEFAULT_PAGE_MODE);
  useEffect(() => watchPageMode(setMode), []);
  const choose = (value: PageMode) => {
    setMode(value);
    void savePageMode(value);
  };
  return [mode, choose];
}

/** 名稱輸入（新增作品／取名字）；送出空白不算。 */
function NameForm({ label, submit, initial = '', onDone }: { label: string; submit: string; initial?: string; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState(initial);
  return (
    <form
      class="series-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onDone(name.trim());
      }}
    >
      <input aria-label={label} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <Button variant="primary" type="submit">
        {submit}
      </Button>
      <Button onClick={() => onDone(undefined)}>取消</Button>
    </form>
  );
}

/** 作品卡的「為什麼歸到這部」（#186）。 */
function assignmentReason(assignment: SeriesResponse['assignment']): string | undefined {
  const title = assignment?.originalTitle;
  switch (assignment?.by) {
    case 'urlPattern':
      return '之前在這個網址選過這部作品';
    case 'title':
      return `頁面標題猜到原名「${title}」，跟這部作品相同`;
    case 'created':
      return `頁面標題猜到原名「${title}」，還沒有這部作品，所以新建一部`;
    case 'unnamed':
      return '頁面上看不出作品名稱，所以新建一部未命名作品';
    case 'manual':
      return '你選了這部作品';
    default:
      return undefined;
  }
}

/** 搜尋作品清單：比對名稱、中文譯名與原名（忽略大小寫與全形半形）。 */
const matchesQuery = (option: SeriesOption, query: string) => {
  const q = query.normalize('NFKC').toLowerCase().trim();
  return q === '' || [option.label, option.title, ...(option.originalTitles ?? [])].some((t) => t.normalize('NFKC').toLowerCase().includes(q));
};

/** 這個 tab 目前的 Series 與作品清單；作品歸類、狀態或條目數變了就重讀。作品卡與作品頁各自訂閱。 */
function useSeries(tabId: number): SeriesResponse | undefined {
  const [series, setSeries] = useState<SeriesResponse | undefined>(undefined);
  useEffect(() => {
    const refresh = () => void send<SeriesResponse>({ type: 'panel:getSeries', tabId }).then(setSeries);
    const onMessage = (message: Message) => {
      if ((message.type === 'series:changed' || message.type === 'status:changed') && message.tabId === tabId) refresh();
      // 條目數會變
      if (message.type === 'notes:changed') refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    refresh();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);
  return series;
}

const currentOption = (series: SeriesResponse | undefined) => series?.options.find((o) => o.id === series.current);

/** 從作品卡打開作品頁或換一部作品；rename＝打開作品頁時直接顯示改名（取名字）表單。 */
type OpenSeries = (page: SeriesPage, opts?: { rename?: boolean }) => void;

/** Provisional Series 的問句列（#186），作品卡與作品頁都有：猜到原名是［是］［換一部］，猜不出來是［取名字］［選一部］。 */
function AskRow({ tabId, ask, onRename, onPick }: { tabId: number; ask: 'confirm' | 'name'; onRename: () => void; onPick: () => void }) {
  return (
    <div class="series-card__ask" role="group" aria-label="確認作品">
      <span class="series-card__question">{ask === 'confirm' ? '這是正確的作品嗎？' : '看不出是哪部作品'}</span>
      {ask === 'confirm' ? (
        <Button variant="primary" onClick={() => void send({ type: 'panel:confirmSeries', tabId })}>
          是
        </Button>
      ) : (
        <Button variant="primary" onClick={onRename}>
          取名字
        </Button>
      )}
      <Button onClick={onPick}>{ask === 'confirm' ? '換一部' : '選一部'}</Button>
    </div>
  );
}

/**
 * Transcript 上方的作品卡（#186；#191 定案為 prototype C3）：只有中文譯名（大）＋原名（小）兩行，整張可以點、打開作品頁。
 * 讀者還沒確認的作品下面有問句列（不在可點的範圍裡）。
 */
function SeriesCard({ tabId, onOpen }: { tabId: number; onOpen: OpenSeries }) {
  const series = useSeries(tabId);
  const current = currentOption(series);
  if (!series || !current) return null;
  const { ask } = seriesActions(current, series.options);
  return (
    <section aria-label="作品" class="series-card">
      <button type="button" class="series-card__open" aria-label={`作品：${current.title}`} onClick={() => onOpen('series')}>
        <span class="series-card__names">
          <span class="series-card__title">{current.title}</span>
          {current.subtitle && (
            <span class="series-card__original" lang="ja">
              {current.subtitle}
            </span>
          )}
        </span>
        <span class="series-card__chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {ask && <AskRow tabId={tabId} ask={ask} onRename={() => onOpen('series', { rename: true })} onPick={() => onOpen('seriesPick')} />}
    </section>
  );
}

/**
 * 作品頁（#191）：作品身分（名稱與改名、原名、問句列或「不是這部作品？」）→ 角色與用語 → 最底部清除快取。
 * 從作品卡打開，整個取代 side panel。
 */
function SeriesPageView({
  tabId,
  navigate,
  renameOnOpen,
  onRenameOpened,
}: {
  tabId: number;
  navigate: (page: SeriesPage | undefined) => void;
  /** 作品卡的「取名字」：一打開就顯示取名字表單。 */
  renameOnOpen: boolean;
  /** 表單顯示過了：container 清掉 renameOnOpen，之後不管從哪裡回到作品頁都不會再自動打開。 */
  onRenameOpened: () => void;
}) {
  const series = useSeries(tabId);
  const [renaming, setRenaming] = useState(renameOnOpen);
  useEffect(() => {
    if (renameOnOpen) onRenameOpened();
  }, []);
  const current = currentOption(series);
  if (!series || !current) return null;
  const actions = seriesActions(current, series.options);
  const info = [current.provisional ? '自動判斷' : '已確認', `${series.notesCount ?? 0} 個條目`].join(' · ');
  return (
    <>
      <section aria-label="作品身分" class="series-identity">
        {renaming ? (
          <NameForm
            label="作品名稱"
            submit="儲存"
            initial={actions.rename === '取名字' ? '' : current.title}
            onDone={(name) => {
              setRenaming(false);
              if (name) void send({ type: 'panel:renameSeries', tabId, name });
            }}
          />
        ) : (
          <div class="series-identity__row">
            <h2 class="series-identity__name">{current.title}</h2>
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              {actions.rename}
            </Button>
          </div>
        )}
        {current.subtitle && (
          <span class="series-card__original" lang="ja">
            {current.subtitle}
          </span>
        )}
        <span class="series-card__info">{info}</span>
        {actions.ask && <AskRow tabId={tabId} ask={actions.ask} onRename={() => setRenaming(true)} onPick={() => navigate('seriesPick')} />}
        {!actions.ask && (
          <Button variant="link" class="series-identity__pick" onClick={() => navigate('seriesPick')}>
            不是這部作品？
          </Button>
        )}
      </section>
      <SeriesNotesSection tabId={tabId} />
      <div class="series-danger">
        <ClearCache tabId={tabId} />
      </div>
    </>
  );
}

/**
 * 換一部作品（#191，作品頁再進去的一頁）：為什麼歸到這部、可搜尋的作品清單、新增作品；Provisional 才有「合併進…」。
 * 選好、建好或合併完就回到作品頁（下面的角色與用語換成那一部的）。
 */
function SeriesPickView({ tabId, navigate }: { tabId: number; navigate: (page: SeriesPage | undefined) => void }) {
  const series = useSeries(tabId);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const current = currentOption(series);
  if (!series || !current) return null;
  const { mergeTargets } = seriesActions(current, series.options);
  const reason = assignmentReason(series.assignment);
  const done = () => navigate('series');
  return (
    <section aria-label="換一部作品" class="series-pick">
      {reason && <p class="series-pick__why">{reason}</p>}
      <input aria-label="搜尋作品" placeholder="搜尋作品…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      <ul aria-label="作品清單" class="series-pick__list">
        {series.options
          .filter((o) => matchesQuery(o, query))
          .map((o) => (
            <li key={o.id}>
              <button
                type="button"
                class="series-item"
                aria-current={o.id === current.id}
                onClick={() => {
                  if (o.id !== current.id) void send({ type: 'panel:selectSeries', tabId, seriesId: o.id });
                  done();
                }}
              >
                <span class="series-item__text">
                  <span class="series-item__title">{o.title}</span>
                  {o.subtitle && (
                    <span class="series-item__original" lang="ja">
                      {o.subtitle}
                    </span>
                  )}
                </span>
                {o.provisional && <span class="series-item__meta">自動</span>}
              </button>
            </li>
          ))}
      </ul>
      {creating ? (
        <NameForm
          label="新作品名稱"
          submit="建立"
          onDone={(name) => {
            setCreating(false);
            if (!name) return;
            void send({ type: 'panel:createSeries', tabId, name });
            done();
          }}
        />
      ) : (
        <div class="naru-row">
          <Button variant="ghost" onClick={() => setCreating(true)}>
            ＋ 新增作品…
          </Button>
        </div>
      )}
      {mergeTargets.length > 0 && (
        <form
          class="series-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mergeTarget) return;
            void send({ type: 'panel:mergeSeries', tabId, targetId: mergeTarget });
            done();
          }}
        >
          <select aria-label="合併進" value={mergeTarget} onChange={(e) => setMergeTarget(e.currentTarget.value)}>
            <option value="">合併進…</option>
            {mergeTargets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
          <Button type="submit">合併</Button>
        </form>
      )}
    </section>
  );
}

/**
 * 外掛的 container（#108）：接 chrome 訊息、API key、同意狀態與 Page Mode 的 store，把資料交給純畫面的 SidePanel。
 * 會讀寫 store 的區塊（設定頁、作品卡、作品頁與換一部作品）也在這裡，以 slot／render prop 交給 SidePanel。
 * 沒做完 onboarding（#93）時 SidePanel 只顯示「完成設定」；「登入」「完成設定」用新分頁打開 onboarding。
 */
function App({ tabId }: { tabId: number | undefined }) {
  // undefined＝還在問 SW
  const [active, setActive] = useState<boolean | undefined>(tabId === undefined ? false : undefined);
  const [pages, setPages] = useState<PageView[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' });
  const [hasKey, setHasKey] = useState(true);
  const [pageMode, choosePageMode] = usePageMode();
  const [hovered, setHovered] = useState<LineRef | undefined>(undefined);
  const consent = useDataConsent();
  const translationMode = useTranslationMode();
  const session = useHostedSession();
  const quota = useHostedQuota(session);
  const onboarding = useOnboarding();
  const hostedHint = useHostedHint();
  const subscribedNotice = useSubscribedNotice();
  const [paymentFailed, runPayment] = usePaymentAction();
  /** 作品卡的「取名字」：打開作品頁時直接顯示取名字表單（#191）。 */
  const [renameOnOpen, setRenameOnOpen] = useState(false);

  useEffect(() => {
    void apiKeys.get().then((key) => setHasKey(Boolean(key)));
  }, []);

  useEffect(() => {
    if (tabId === undefined) return;
    const onMessage = (message: Message, sender: chrome.runtime.MessageSender) => {
      if (message.type === 'content:hover' && sender.tab?.id === tabId)
        setHovered(message.line ?? undefined);
      if (message.type === 'status:changed' && message.tabId === tabId) setActive(message.active);
      if (message.type === 'pages:updated' && message.tabId === tabId) setPages(message.pages);
      if (message.type === 'models:status') setModelStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void send<StatusResponse>({ type: 'panel:getStatus', tabId }).then((r) => setActive(r.active));
    void send<PagesResponse>({ type: 'panel:getPages', tabId }).then((r) => setPages(r.pages));
    void send<ModelStatusResponse>({ type: 'panel:getModelStatus' }).then((r) => setModelStatus(r.status));
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  if (active === undefined || translationMode === undefined || session === undefined || onboarding === undefined) return null;
  const running = active && tabId !== undefined;
  // 停止、擷取、翻譯、逐字稿 hover 只在 running（有 tabId）時出現，所以 tabId! 是安全的
  return (
    <SidePanel
      running={running}
      pages={pages}
      modelStatus={modelStatus}
      access={translationMode === 'hosted' ? { mode: 'hosted', signedIn: session !== null } : { mode: 'ownKey', hasKey }}
      consented={consent?.[translationMode]}
      pageMode={pageMode}
      hovered={hovered}
      logoSrc="icons/naruhodo-small.svg"
      onPageModeChange={choosePageMode}
      onScan={() => void send({ type: 'panel:scan', tabId: tabId! })}
      onTranslate={(pageHash) => void send({ type: 'panel:translate', tabId: tabId!, ...(pageHash === undefined ? {} : { pageHash }) })}
      onLineHover={(line) => {
        chrome.tabs.sendMessage(tabId!, { type: 'content:highlight', line } satisfies Message).catch(() => {});
      }}
      // 說明卡只在自備金鑰時出現；同意後已啟動的分頁由 SW 直接開始翻譯
      onAcceptConsent={() => void grantDataConsent('ownKey')}
      onUseOwnKey={() => void saveTranslationMode('ownKey')}
      onSignIn={() => openOnboarding('signIn')}
      setupComplete={onboarding === 'done'}
      onFinishSetup={() => openOnboarding()}
      hostedHint={hostedHint}
      onDismissHostedHint={() => void dismissHostedHint()}
      quota={translationMode === 'hosted' ? quota : undefined}
      onSubscribe={session ? () => runPayment(() => subscribe(session, 'panel', tabId)) : undefined}
      paymentFailed={paymentFailed}
      subscribedNotice={subscribedNotice}
      onDismissSubscribedNotice={() => void dismissSubscribedNotice()}
      renderSeriesCard={(open) =>
        running && (
          <SeriesCard
            tabId={tabId}
            onOpen={(page, opts) => {
              setRenameOnOpen(opts?.rename ?? false);
              open(page);
            }}
          />
        )
      }
      renderSettings={() => <Settings mode={translationMode} session={session} quota={quota} onKeyChanged={setHasKey} />}
      renderSeries={(page, navigate) => {
        if (tabId === undefined) return null;
        if (page === 'seriesPick') return <SeriesPickView tabId={tabId} navigate={navigate} />;
        return <SeriesPageView tabId={tabId} navigate={navigate} renameOnOpen={renameOnOpen} onRenameOpened={() => setRenameOnOpen(false)} />;
      }}
    />
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
