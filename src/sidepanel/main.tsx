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
  AutoTranslateResponse,
  PagesResponse,
  PageView,
  SeriesResponse,
  StatusResponse,
  TestConnectionResponse,
} from '../shared/messages.ts';
import { deleteAccount, signOut, type AccountExitDeps } from '../shared/account-exit.ts';
import { createHostedAccountClient } from '../shared/hosted-account-client.ts';
import type { Quota } from '../shared/hosted-api.ts';
import { clearHostedSession, HOSTED_API_URL, loadHostedSession, type HostedSession } from '../shared/hosted-session.ts';
import { dismissHostedHint, onboardingUrl, watchHostedHint, watchOnboarding, type OnboardingProgress } from '../shared/onboarding.ts';
import { DEFAULT_PAGE_MODE, savePageMode, watchPageMode, type PageMode } from '../shared/page-mode.ts';
import { saveTranslationMode, watchTranslationMode, type TranslationMode } from '../shared/translation-mode.ts';
import { Badge, Button, RadioCard, Switch } from '../ui/components.tsx';
import { DeleteAccount } from '../ui/delete-account.tsx';
import { SidePanel } from '../ui/side-panel.tsx';
import { PaymentUnavailable, SubscribeButton } from '../ui/subscribe-button.tsx';
import { accountPlanView } from '../ui/view.ts';
import { SeriesNotesSection } from './series-notes.tsx';

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

const hostedAccount = createHostedAccountClient({ apiUrl: HOSTED_API_URL, fetch: (url, init) => fetch(url, init) });

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

/** 用新分頁打開 onboarding（#93）；signIn＝從第 2 步開始。 */
const openOnboarding = (step?: 'signIn') => void chrome.tabs.create({ url: onboardingUrl(step) });

/** 「訂閱」：向 Worker 建立 checkout，用新分頁打開產品網站的 checkout 頁（#94）。已經訂閱中就重讀額度。失敗回 false。 */
async function subscribe(session: HostedSession): Promise<boolean> {
  const result = await hostedAccount.checkout(session.token, 'zh-tw');
  if (result.ok) void chrome.tabs.create({ url: result.url });
  else if (result.reason === 'alreadySubscribed') void chrome.runtime.sendMessage({ type: 'quota:changed' } satisfies Message).catch(() => {});
  else {
    console.error('建立 checkout 失敗', result.message);
    return false;
  }
  return true;
}

/** 「管理訂閱」：向 Worker 建立 Paddle customer portal session，用新分頁打開（取消訂閱、更新付款方式、收據）。失敗回 false。 */
async function managePlan(session: HostedSession): Promise<boolean> {
  const result = await hostedAccount.portal(session.token);
  if (result.ok) void chrome.tabs.create({ url: result.url });
  else console.error('打開 customer portal 失敗', result.message);
  return result.ok;
}

/** 「訂閱」「管理訂閱」的按鈕：失敗時記下來讓畫面顯示錯誤（#156），再按一次先清掉。 */
function usePaymentAction(): [failed: boolean, run: (action: () => Promise<boolean>) => void] {
  const [failed, setFailed] = useState(false);
  const run = (action: () => Promise<boolean>) => {
    setFailed(false);
    void action().then((ok) => setFailed(!ok));
  };
  return [failed, run];
}

/** 這個 side panel 自己改了 session：runtime 訊息不會送回給發送的一方，自己的 useHostedSession 另外通知。 */
const sessionChangedHere = new EventTarget();

/** 登出、刪除帳號之後：清掉本機的 session，廣播給 SW 與其他 side panel，也通知自己。 */
const accountExit: AccountExitDeps = {
  auth: hostedAccount,
  clearSession: () => clearHostedSession().then(() => {}),
  broadcast: () => {
    sessionChangedHere.dispatchEvent(new Event('change'));
    void chrome.runtime.sendMessage({ type: 'session:changed' } satisfies Message).catch(() => {});
  },
};

/**
 * 設定頁「內建翻譯」卡片展開的內容（#93、#94、#95 畫面定案）：已登入時是 email＋方案 Badge、剩餘說明，免費是「訂閱」、訂閱者是「管理訂閱」，
 * 再來是「登出」（直接登出，不確認）與 ghost 紅字「刪除帳號」（換到確認頁）；沒登入時是「登入」，打開 onboarding 的第 2 步。
 */
function HostedAccount({
  session,
  quota,
  onDeleteAccount,
}: {
  session: HostedSession | null;
  quota: Quota | undefined;
  onDeleteAccount: () => void;
}) {
  const [paymentFailed, runPayment] = usePaymentAction();
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
      {paymentFailed && <PaymentUnavailable />}
      <div class="actions">
        {plan?.subscribed ? (
          <Button onClick={() => runPayment(() => managePlan(session))}>管理訂閱</Button>
        ) : (
          <SubscribeButton variant="primary" onSubscribe={plan && (() => runPayment(() => subscribe(session)))} />
        )}
        <Button onClick={() => void signOut(accountExit, session.token)}>登出</Button>
        <Button variant="ghost" class="naru-text-danger" onClick={onDeleteAccount}>
          刪除帳號
        </Button>
      </div>
    </>
  );
}

/** 刪除帳號的確認頁（#95）：刪除成功後回到設定頁，那時已經是未登入。 */
function DeleteAccountPage({ session, onDone }: { session: HostedSession | null; onDone: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  // 別的 side panel 已經登出、或刪除成功之後：這一頁沒有帳號可以刪了
  useEffect(() => {
    if (!session) onDone();
  }, [session]);
  if (!session) return null;

  async function confirm(token: string) {
    setDeleting(true);
    setFailed(false);
    const result = await deleteAccount(accountExit, token);
    setDeleting(false);
    if (result.ok) return;
    console.error('刪除帳號失敗', result.message);
    setFailed(true);
  }

  return <DeleteAccount email={session.email} deleting={deleting} failed={failed} onConfirm={() => void confirm(session.token)} onCancel={onDone} />;
}

/**
 * 設定頁「自備金鑰」卡片展開的內容（spec #27 第 5 節）：API key 存在外掛 origin 的 IndexedDB，只顯示末四碼。
 * side panel 自己讀寫 key；「測試連線」由 offscreen 讀 key 呼叫 API，訊息裡不帶 key。
 */
function OwnKey({ session, onKeyChanged }: { session: HostedSession | null; onKeyChanged: (hasKey: boolean) => void }) {
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
      {session && <p class="hint">帳號 {session.email} 仍然登入著；切回內建翻譯就能接著用。</p>}
    </>
  );
}

/**
 * 設定頁（#93 畫面定案）：從 ⚙ 選單的「設定」打開，整個 side panel 換成這一頁。
 * 翻譯方式是明確的二選一（不會自動切換；切到自備金鑰不會登出），下面是匯出／匯入。
 */
function Settings({
  mode,
  session,
  quota,
  onKeyChanged,
  onDeleteAccount,
}: {
  mode: TranslationMode;
  session: HostedSession | null;
  quota: Quota | undefined;
  onKeyChanged: (hasKey: boolean) => void;
  onDeleteAccount: () => void;
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
          <HostedAccount session={session} quota={quota} onDeleteAccount={onDeleteAccount} />
        </RadioCard>
        <RadioCard
          name="translation-mode"
          title="自備金鑰"
          description="用你自己的 Anthropic API key，費用直接付給 Anthropic，沒有頁數限制"
          checked={mode === 'ownKey'}
          onSelect={() => void saveTranslationMode('ownKey')}
        >
          <OwnKey session={session} onKeyChanged={onKeyChanged} />
        </RadioCard>
      </div>
      <h2>資料</h2>
      <p class="hint">在兩台電腦之間搬 Series、Series Notes 與翻譯快取（不含 API key 與帳號）。</p>
      <Backup />
    </section>
  );
}

/** undefined＝還在讀。 */
function useTranslationMode(): TranslationMode | undefined {
  const [mode, setMode] = useState<TranslationMode | undefined>(undefined);
  useEffect(() => watchTranslationMode(setMode), []);
  return mode;
}

/**
 * Hosted Translation 的 session（IndexedDB）；undefined＝還在讀，null＝沒登入。
 * onboarding 頁登入、或 SW 發現 token 失效而清掉時，收到 session:changed 重新讀；這個 side panel 自己登出、刪除帳號時也重新讀。
 */
function useHostedSession(): HostedSession | null | undefined {
  const [session, setSession] = useState<HostedSession | null | undefined>(undefined);
  useEffect(() => {
    const refresh = () => void loadHostedSession().then((s) => setSession(s ?? null));
    const onMessage = (message: Message) => {
      if (message.type === 'session:changed') refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    sessionChangedHere.addEventListener('change', refresh);
    refresh();
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      sessionChangedHere.removeEventListener('change', refresh);
    };
  }, []);
  return session;
}

/**
 * 內建翻譯的剩餘額度（#92）：登入後向 Worker 讀；SW 說額度變了（翻譯扣了一頁、Worker 說用完）就重新讀。
 * side panel 重新取得焦點、或重新變成可見時也重讀（#94）：在新分頁付完款回來，就看到已訂閱。side panel 跟著漫畫分頁，
 * 切到付款分頁時它被隱藏，切回來時不一定有 focus 事件，所以兩個都聽。
 * 沒登入或讀不到時是 undefined（token 失效由 SW 的 Hosted Translator 處理，這裡不管）。
 */
function useHostedQuota(session: HostedSession | null | undefined): Quota | undefined {
  const [quota, setQuota] = useState<Quota | undefined>(undefined);
  const token = session?.token;
  useEffect(() => {
    setQuota(undefined);
    if (!token) return;
    let current = true;
    const refresh = () =>
      void hostedAccount.account(token).then((r) => {
        if (current && r.ok) setQuota(r.account.quota);
      });
    const onMessage = (message: Message) => {
      if (message.type === 'quota:changed') refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    refresh();
    return () => {
      current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);
  return quota;
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

/** 自動翻譯開關（spec #27 第 3.4、8 節；預設開）；關掉後翻頁只顯示快取，其他要按「翻譯此頁」。 */
function AutoTranslateToggle({ tabId }: { tabId: number }) {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    void send<AutoTranslateResponse>({ type: 'panel:getAutoTranslate', tabId }).then((r) => setEnabled(r.enabled));
  }, [tabId]);
  const toggle = (value: boolean) => {
    setEnabled(value);
    void send({ type: 'panel:setAutoTranslate', tabId, enabled: value });
  };
  return <Switch label="自動翻譯" description="翻頁就翻，關掉只顯示快取" checked={enabled} onChange={toggle} />;
}

const NEW_SERIES = '__new__';

/** 名稱輸入（新增 Series／改名）；送出空白不算。 */
function NameForm({ label, submit, initial = '', onDone }: { label: string; submit: string; initial?: string; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState(initial);
  return (
    <form
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

/** 鉛筆圖示（改系列名稱）。 */
function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/**
 * 底部列的系列（spec #27 第 8 節、#36、#77）：平常只是一行「系列＋名稱（過長截斷）＋鉛筆」；點鉛筆才展開編輯區：
 * 改名、切換 Series（最近用過的在最上面、Provisional Series 顯示為「未歸類」、「新增 Series…」）、
 * 把 Provisional Series 合併進既有 Series。
 */
function SeriesPicker({ tabId }: { tabId: number }) {
  const [series, setSeries] = useState<SeriesResponse | undefined>(undefined);
  /** undefined＝收起；rename＝鉛筆打開的編輯區；new＝在編輯區選了「新增 Series…」 */
  const [editing, setEditing] = useState<'new' | 'rename' | undefined>(undefined);
  const [mergeTarget, setMergeTarget] = useState('');

  useEffect(() => {
    const refresh = () => void send<SeriesResponse>({ type: 'panel:getSeries', tabId }).then(setSeries);
    const onMessage = (message: Message) => {
      if ((message.type === 'series:changed' || message.type === 'status:changed') && message.tabId === tabId) refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    refresh();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  if (!series?.current) return null;
  const current = series.options.find((o) => o.id === series.current);
  const targets = series.options.filter((o) => !o.provisional && o.id !== series.current);
  const choose = (value: string) => {
    if (value === NEW_SERIES) setEditing('new');
    else {
      setEditing(undefined);
      void send({ type: 'panel:selectSeries', tabId, seriesId: value });
    }
  };
  const label = current?.label ?? '';
  return (
    <>
      <div role="group" aria-label="系列" class="series-row">
        <span class="series-row__label" aria-hidden="true">
          系列
        </span>
        <span class="series-row__name" title={label}>
          {label}
        </span>
        <Button
          variant="icon"
          aria-label="改系列名稱"
          aria-expanded={editing !== undefined}
          onClick={() => setEditing(editing === undefined ? 'rename' : undefined)}
        >
          <PencilIcon />
        </Button>
      </div>
      {editing !== undefined && (
        <section aria-label="編輯系列" class="series-editor">
          {editing === 'rename' && (
            <NameForm
              label="新名稱"
              submit="儲存"
              initial={current?.provisional ? '' : current?.name}
              onDone={(name) => {
                setEditing(undefined);
                if (name) void send({ type: 'panel:renameSeries', tabId, name });
              }}
            />
          )}
          <label class="series-editor__field">
            切換 Series
            <select aria-label="Series" value={editing === 'new' ? NEW_SERIES : series.current} onChange={(e) => choose(e.currentTarget.value)}>
              {series.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
              <option value={NEW_SERIES}>新增 Series…</option>
            </select>
          </label>
          {editing === 'new' && (
            <NameForm
              label="Series 名稱"
              submit="建立"
              onDone={(name) => {
                setEditing(undefined);
                if (name) void send({ type: 'panel:createSeries', tabId, name });
              }}
            />
          )}
          {current?.provisional && targets.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!mergeTarget) return;
                setEditing(undefined);
                void send({ type: 'panel:mergeSeries', tabId, targetId: mergeTarget });
              }}
            >
              <select aria-label="合併進" value={mergeTarget} onChange={(e) => setMergeTarget(e.currentTarget.value)}>
                <option value="">合併進…</option>
                {targets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Button type="submit">合併</Button>
            </form>
          )}
        </section>
      )}
    </>
  );
}

/**
 * 外掛的 container（#108）：接 chrome 訊息、API key、同意狀態與 Page Mode 的 store，把資料交給純畫面的 SidePanel。
 * 會讀寫 store 的區塊（設定頁、Series Notes 頁、系列、自動翻譯開關）也在這裡，以 slot 交給 SidePanel。
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
  const [paymentFailed, runPayment] = usePaymentAction();

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
      logoSrc="icons/naruhodo.svg"
      onPageModeChange={choosePageMode}
      onStop={() => void send({ type: 'panel:stop', tabId: tabId! })}
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
      onSubscribe={session ? () => runPayment(() => subscribe(session)) : undefined}
      paymentFailed={paymentFailed}
      autoTranslate={running && <AutoTranslateToggle tabId={tabId} />}
      series={running && <SeriesPicker tabId={tabId} />}
      renderSettings={(_close, openDeleteAccount) => (
        <Settings mode={translationMode} session={session} quota={quota} onKeyChanged={setHasKey} onDeleteAccount={openDeleteAccount} />
      )}
      renderDeleteAccount={(back) => <DeleteAccountPage session={session} onDone={back} />}
      renderNotes={() => tabId !== undefined && <SeriesNotesSection tabId={tabId} />}
    />
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
