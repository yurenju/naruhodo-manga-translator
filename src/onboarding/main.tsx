/**
 * 全頁 onboarding（#93 畫面定案的版本 A：單欄步驟精靈）。全新安裝時 SW 用新分頁打開；side panel 的「完成設定」
 * 回到停下來的那一步，「登入」「改用內建翻譯」從第 2 步開始（?step=signIn）。
 *
 * 1 說明 → 2 同意並登入（SignIn；按「同意並寄送驗證碼」就記下內建翻譯的同意）→ 3 選擇方案 → 4 到網站的試翻頁試翻一頁（#169），按「完成」關掉分頁。
 * 按下「開始設定」（或回到 onboarding 後那一步的主要按鈕）就請 SW 在背景下載辨識模型，右下角的藥丸顯示進度（#169）。
 * 頁尾「使用自備金鑰」換成一個不在步驟裡的畫面：存 key 並同意自備金鑰的說明，完成後跳到第 4 步。
 * 選了方案或存了 key 就算設定完成（side panel 不再顯示「完成設定」）；之後的同意、登入、模式切換由 SW 接著翻已啟動的分頁。
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import { grantDataConsent, hasDataConsent } from '../shared/data-consent.ts';
import { FREE_PAGES, MONTHLY_PAGES } from '../shared/hosted-api.ts';
import { createHostedAccountClient } from '../shared/hosted-account-client.ts';
import { HOSTED_API_URL, loadHostedSession, saveHostedSession, type HostedSession } from '../shared/hosted-session.ts';
import type { Message, ModelStatus, ModelStatusResponse } from '../shared/messages.ts';
import { downloadNotice, downloadPill } from '../shared/model-download.ts';
import { loadOnboarding, onboardingRequest, saveOnboarding, startStep, type OnboardingProgress, type OnboardingStep, type RequestedStep } from '../shared/onboarding.ts';
import { savePageMode } from '../shared/page-mode.ts';
import { openPayment, ownPaymentChange, watchPendingPayment, type PendingPayment } from '../shared/payment-return.ts';
import { saveTranslationMode } from '../shared/translation-mode.ts';
import { Badge, Button, Callout } from '../ui/components.tsx';
import { OwnKeyDataFlow, PolicyLinks } from '../ui/data-flow.tsx';
import { PRACTICE_URL } from '../ui/links.ts';
import { SignIn } from '../ui/sign-in.tsx';
import { billingPeriodOffer, pages } from '../ui/pricing.ts';
import { OfferText, SubscribeButton, SubscriptionPrice } from '../ui/subscribe-button.tsx';

const hostedAccount = createHostedAccountClient({ apiUrl: HOSTED_API_URL, fetch: (url, init) => fetch(url, init) });

const apiKeys = indexedDbApiKeyStore();

const LOGO = 'icons/naruhodo-small.svg';

/** 進度點上的四步。 */
const STEPS: { step: OnboardingStep; title: string }[] = [
  { step: 'intro', title: '說明' },
  { step: 'signIn', title: '同意並登入' },
  { step: 'plan', title: '選擇方案' },
  { step: 'tutorial', title: '開始翻譯' },
];

function Dots({ current }: { current: OnboardingStep }) {
  const index = STEPS.findIndex((s) => s.step === current);
  return (
    <ol class="ob-dots" aria-label="步驟">
      {STEPS.map((s, i) => (
        <li key={s.step} class={i < index ? 'done' : i === index ? 'cur' : undefined} aria-current={i === index ? 'step' : undefined}>
          <span aria-hidden="true">{i + 1}</span>
          {s.title}
        </li>
      ))}
    </ol>
  );
}

/** downloadBytes：模型還沒下載時才有（第 1 步說明會在背景下載多少）。 */
function Intro({ downloadBytes, onNext }: { downloadBytes: number | undefined; onNext: () => void }) {
  return (
    <>
      <h1 class="ob-h1">歡迎使用 Naruhodo</h1>
      <p class="ob-lead">在日文漫畫網站上，把對話框直接換成中文；也可以保留日文、滑過看讀音，拿來學日文。</p>
      <div class="ob-price">
        <ul>
          <li>
            用 email 註冊之後，有 <strong>{FREE_PAGES} 頁的免費額度</strong>（大約兩話），不用輸入付款資料。
          </li>
          <li>
            試用滿意的話，可以訂閱：<OfferText offer={billingPeriodOffer('yearly')} />，或 <OfferText offer={billingPeriodOffer('quarterly')} />，每月可翻 {pages(MONTHLY_PAGES)} 頁。
          </li>
          <li>回頭看已經翻過的頁面不會扣頁數；翻譯失敗也不扣。</li>
        </ul>
      </div>
      {downloadBytes !== undefined && <p class="ob-notice">{downloadNotice(downloadBytes)}</p>}
      <Button variant="primary" class="ob-big" onClick={onNext}>
        開始設定
      </Button>
    </>
  );
}

/** 右下角的下載進度（#169）。沒有暫停、取消。 */
function DownloadPill({ status, started }: { status: ModelStatus; started: boolean }) {
  const pill = downloadPill(status, started);
  if (!pill) return null;
  return (
    <p class={pill.done ? 'ob-pill ob-pill--done' : 'ob-pill'} role="status" title="外掛在背景下載辨識日文的模型，只需要一次">
      {!pill.done && <span class="ob-pill__spin" aria-hidden="true" />}
      {pill.text}
    </p>
  );
}

/**
 * 第 3 步的子畫面：向 Worker 讀方案 → 選方案 → 付款頁開在新分頁、等付款完成 → 訂閱中。
 * justPaid：在這裡付完款的是「訂閱完成」，本來就訂閱的是「已訂閱」（#167）；limit：讀不到（只知道 Worker 回了 alreadySubscribed）就不顯示頁數。
 */
type PlanState =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'waitingPayment'; url: string }
  | { kind: 'subscribed'; limit: number | undefined; justPaid: boolean };

/**
 * 第 3 步：選擇方案（#93、#94 畫面定案）。一進來先向 Worker 讀一次方案（#167）：已經訂閱中（剛登入，或已登入時重開 onboarding）
 * 就不顯示方案選擇，直接是「已訂閱」並呼叫 onSubscribed；讀不到就照常選方案。
 * 「訂閱」向 Worker 建立 checkout，請 SW 用新分頁打開產品網站的 checkout 頁（Paddle 處理付款）。
 * SW 每隔幾秒查一次方案，確認了就關掉付款分頁、帶讀者回到這裡（#176）。這裡看 SW 記的付款狀態：付款分頁還開著是「在付款分頁完成付款」，
 * 被關掉了是「付款頁已經關閉」；SW 清掉付款狀態時（確認了、或關掉 10 分鐘後放棄）向 Worker 讀一次方案，
 * 訂閱中就換成「訂閱完成」並呼叫 onSubscribed（設定完成），「下一步」才到第 4 步；不是就回到選方案。
 */
function Plan({
  session,
  onChoose,
  onFree,
  onSubscribed,
  onNext,
}: {
  session: HostedSession;
  /** 按了任一個方案（開始下載辨識模型，#169）。 */
  onChoose: () => void;
  onFree: () => void;
  onSubscribed: () => void;
  onNext: () => void;
}) {
  const [state, setState] = useState<PlanState>({ kind: 'loading' });
  const [failure, setFailure] = useState<string | undefined>(undefined);
  /** SW 記的、從 onboarding 發起的付款；undefined＝沒有。 */
  const [pending, setPending] = useState<PendingPayment | undefined>(undefined);

  const free = () => {
    onChoose();
    onFree();
  };

  /** 向 Worker 讀方案：訂閱中回傳 Monthly Page Limit，不是或讀不到回 undefined。 */
  async function subscribedLimit(): Promise<number | undefined> {
    const r = await hostedAccount.account(session.token);
    return r.ok && r.account.quota.plan === 'subscribed' ? r.account.quota.limit : undefined;
  }

  const showSubscribed = (limit: number | undefined, justPaid: boolean) => {
    setState({ kind: 'subscribed', limit, justPaid });
    onSubscribed();
  };

  async function subscribe() {
    onChoose();
    setFailure(undefined);
    // 第 3 步現在只有年繳的卡片（#258 改成單選清單，選季繳或年繳）
    const result = await hostedAccount.checkout(session.token, 'zh-tw', 'yearly');
    if (result.ok) {
      setState({ kind: 'waitingPayment', url: result.url });
      await openPayment(result.url, 'onboarding', 'yearly');
    } else if (result.reason === 'alreadySubscribed') {
      // Worker 已經說訂閱中：讀不到頁數上限也照樣是「已訂閱」
      showSubscribed(await subscribedLimit(), false);
    } else setFailure(`付款頁沒有打開：${result.message}`);
  }

  useEffect(() => {
    // active：離開第 3 步（上一步、自備金鑰）之後才回來的結果不再改設定；paying：付款中（重新整理）交給付款狀態處理
    let active = true;
    let paying = false;
    void subscribedLimit().then((limit) => {
      if (!active || paying) return;
      if (limit !== undefined) showSubscribed(limit, false);
      else setState((s) => (s.kind === 'loading' ? { kind: 'choose' } : s));
    });

    let previous: PendingPayment | undefined;
    const stop = watchPendingPayment((next) => {
      const { mine, action } = ownPaymentChange('onboarding', previous, next);
      if (action === 'wait') {
        paying = true;
        setState((s) => (s.kind === 'choose' || s.kind === 'loading' ? { kind: 'waitingPayment', url: '' } : s));
      }
      if (action === 'settled')
        void subscribedLimit().then((limit) => {
          if (!active) return;
          if (limit !== undefined) showSubscribed(limit, true);
          else setState((s) => (s.kind === 'waitingPayment' ? { kind: 'choose' } : s));
        });
      previous = mine;
      setPending(mine);
    });
    return () => {
      active = false;
      stop();
    };
  }, []);

  if (state.kind === 'waitingPayment') {
    // 付款頁的網址（重新整理後沒有）：沒有的話重新向 Worker 建一個
    const reopen = () => (state.url ? void openPayment(state.url, 'onboarding', 'yearly') : void subscribe());
    if (pending?.checkoutTabId === null)
      return (
        <>
          <h2 class="ob-h2">付款頁已經關閉</h2>
          <p>還沒付款的話，可以重新打開付款頁，或先用免費額度。</p>
          <div class="naru-row">
            <Button onClick={reopen}>重新打開付款頁</Button>
            <Button variant="ghost" onClick={free}>
              改成先用免費額度
            </Button>
          </div>
          <p class="hint" role="status">
            如果你已經付款，確認後這裡會自動更新。
          </p>
        </>
      );
    return (
      <>
        <h2 class="ob-h2">在付款分頁完成付款</h2>
        <p>付款頁已經在另一個分頁打開（由 Paddle 處理付款）。付款完成後，會自動帶你回到這裡。</p>
        <div class="naru-row">
          <Button onClick={reopen}>回到付款頁</Button>
          <Button variant="ghost" onClick={free}>
            改成先用免費額度
          </Button>
        </div>
      </>
    );
  }
  if (state.kind === 'loading')
    return (
      <p class="hint" role="status">
        正在讀取方案…
      </p>
    );
  if (state.kind === 'subscribed')
    return (
      <>
        <h2 class="ob-h2">{state.justPaid ? '訂閱完成' : '已訂閱'}</h2>
        {!state.justPaid && (
          <p>
            已登入 <strong>{session.email}</strong>，這個帳號已經訂閱，不用再選方案。
          </p>
        )}
        <Callout tone="info">
          <p>
            {state.limit === undefined
              ? '✓ 已訂閱。'
              : `✓ 已訂閱：每月可翻 ${state.limit} 頁，${state.justPaid ? '每個月的今天重置' : '從訂閱那天起每月同一天重置'}。`}
          </p>
        </Callout>
        <Button variant="primary" class="ob-big" onClick={onNext}>
          下一步
        </Button>
      </>
    );
  return (
    <>
      <h2 class="ob-h2">選擇方案</h2>
      <p>
        已登入 <strong>{session.email}</strong>。你可以現在訂閱，或先用免費額度試試看。
      </p>
      <div class="ob-plans">
        <section class="ob-plan" aria-label="先用免費額度">
          <p class="ob-plan__name">先用免費額度</p>
          <p class="ob-plan__price">{FREE_PAGES} 頁</p>
          <p class="hint">大約兩話，不會過期。用完再決定要不要訂閱。</p>
          <Button onClick={free}>先用免費的 {FREE_PAGES} 頁</Button>
        </section>
        <section class="ob-plan ob-plan--hl" aria-label="訂閱（年繳）">
          <p class="ob-plan__name">
            訂閱 <Badge tone="solid">年繳</Badge>
          </p>
          <SubscriptionPrice />
          <p class="hint">從訂閱那天起每月同一天重置。隨時取消，用到這一年結束。</p>
          <SubscribeButton variant="primary" onSubscribe={() => void subscribe()} />
        </section>
      </div>
      {failure && (
        <Callout tone="danger" role="alert">
          <p>{failure}</p>
        </Callout>
      )}
    </>
  );
}

/**
 * 走完 onboarding 的新讀者從「閱讀」開始（#185）。Side Panel on Activation 不動（#269）：沒存過值就是開的，
 * 只想看漫畫的人在側邊欄的 ⚙ 設定關掉。進到第 4 步就寫好，Practice Spread 試翻也照這個設定走。
 */
function useReadingDefaults() {
  useEffect(() => {
    void savePageMode('read');
  }, []);
}

/** 點圖示時卡住、在這裡解決之後（#185）：回到漫畫分頁，SW 接著翻畫面上還沒翻的頁（#93），不必再點一次圖示。 */
function ReturnToManga({ from }: { from: number }) {
  return (
    <>
      <h2 class="ob-h2">設定好了</h2>
      <p>回到漫畫後會自動接著翻譯，不用再點一次圖示。</p>
      <Button
        variant="primary"
        class="ob-big"
        onClick={() =>
          void chrome.runtime
            .sendMessage({ type: 'onboarding:return', tabId: from } satisfies Message)
            .catch(() => {})
            .then(() => window.close())
        }
      >
        回到漫畫
      </Button>
    </>
  );
}

/** 第 4 步：到網站的試翻頁，用真的工具列圖示翻一次 Practice Spread（釘選圖示的教學在試翻頁上）。onboarding 分頁不自動關。 */
function TryPractice() {
  useReadingDefaults();
  return (
    <>
      <h2 class="ob-h2">設定完成，來試翻一頁吧</h2>
      <p>我們準備了一張試翻頁的日文漫畫，這一頁不會用到額度。</p>
      <div class="naru-row">
        <Button variant="primary" class="ob-big" onClick={() => void chrome.tabs.create({ url: PRACTICE_URL })}>
          到試翻頁試試看
        </Button>
        <Button class="ob-big" onClick={() => window.close()}>
          完成
        </Button>
      </div>
      <p class="hint">
        之後在任何日文漫畫網站，點工具列上的 Naruhodo 圖示或按 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> 就能翻譯。
      </p>
      <p class="hint">點圖示時會一起打開側邊欄，列出讀音與譯文。只想看漫畫的話，可以在側邊欄的 ⚙ 設定關掉「點圖示時也打開側邊欄」。</p>
    </>
  );
}

/** 頁尾「使用自備金鑰」：按「同意並儲存」同時代表同意自備金鑰版的資料使用說明。 */
function OwnKey({ onSaved, onBack }: { onSaved: (key: string) => void; onBack: () => void }) {
  const [draft, setDraft] = useState('');
  return (
    <section aria-label="使用自備金鑰">
      <h2 class="ob-h2">使用自備金鑰</h2>
      <p>用你自己的 Anthropic API key 翻譯：不需要帳號，也沒有頁數限制，費用由 Anthropic 直接向你收取。</p>
      <OwnKeyDataFlow />
      <p class="hint">
        <PolicyLinks />
      </p>
      <form
        class="ob-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) onSaved(draft.trim());
        }}
      >
        <label class="ob-field">
          Claude API key
          <input type="password" autocomplete="off" spellcheck={false} required value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
        </label>
        <Button variant="primary" type="submit">
          同意並儲存
        </Button>
      </form>
      <p>
        <Button variant="link" onClick={onBack}>
          回到內建翻譯
        </Button>
      </p>
    </section>
  );
}

/** requested＋from：點圖示時卡住（#185），解決了那一步就到「回到漫畫」，不走後面的步驟。 */
function Onboarding({ requested, from }: { requested: RequestedStep | undefined; from: number | undefined }) {
  const [progress, setProgress] = useState<OnboardingProgress | undefined>(undefined);
  const [session, setSession] = useState<HostedSession | null>(null);
  const [step, setStep] = useState<OnboardingStep | undefined>(undefined);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' });
  const [downloadBytes, setDownloadBytes] = useState<number | undefined>(undefined);
  const [downloadStarted, setDownloadStarted] = useState(false);

  useEffect(() => {
    void Promise.all([loadOnboarding(), loadHostedSession(), hasDataConsent('hosted')]).then(([stored, saved, consented]) => {
      setProgress(stored);
      setSession(saved ?? null);
      // 已登入但沒同意（同意的版本更新了）：第 2 步不能跳過，同意就在那一步
      setStep(startStep(stored, Boolean(saved) && consented, requested));
    });
  }, []);

  // 模型狀態跟 side panel 一樣：先問一次，再聽 offscreen 的廣播
  useEffect(() => {
    const listener = (message: Message) => {
      if (message.type === 'models:status') setModelStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    void chrome.runtime.sendMessage<Message, ModelStatusResponse>({ type: 'panel:getModelStatus' }).then((r) => {
      setModelStatus(r.status);
      setDownloadBytes(r.downloadBytes);
    });
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  /** 在背景下載辨識模型（#169）：每一步的主要按鈕都會呼叫；已經在下載或已下載就不再請求。 */
  function startDownload() {
    if (downloadStarted || modelStatus.state !== 'idle') return;
    setDownloadStarted(true);
    void chrome.runtime.sendMessage({ type: 'onboarding:prefetchModels' } satisfies Message).catch(() => {});
  }

  /** 換到下一步，並記下停在哪裡（side panel 的「完成設定」回到這裡）；設定早就完成的（例如從設定頁來登入）不改回未完成。 */
  function go(next: OnboardingStep) {
    setStep(next);
    if (progress !== 'done' && (next === 'intro' || next === 'signIn' || next === 'plan')) {
      setProgress(next);
      void saveOnboarding(next);
    }
  }

  /** 設定完成：side panel 不再顯示「完成設定」。 */
  async function complete() {
    setProgress('done');
    await saveOnboarding('done');
  }

  /** 設定完成之後：從漫畫分頁卡住來的回到漫畫，其他照常到第 4 步。 */
  const afterSetup = (): OnboardingStep => (from === undefined ? 'tutorial' : 'return');

  async function finish() {
    await complete();
    setStep(afterSetup());
  }

  if (step === undefined) return null;
  const back = (to: OnboardingStep) => (
    <p class="ob-back">
      <Button variant="link" onClick={() => go(to)}>
        ← 上一步
      </Button>
    </p>
  );
  return (
    <div class="ob">
      <header class="ob-brand">
        <img src={LOGO} alt="" width={24} height={24} />
        Naruhodo
      </header>
      {step !== 'ownKey' && step !== 'return' && <Dots current={step} />}
      <main class="ob-card">
        {step === 'intro' && (
          <Intro
            downloadBytes={modelStatus.state === 'idle' ? downloadBytes : undefined}
            onNext={() => {
              startDownload();
              go(session ? 'plan' : 'signIn');
            }}
          />
        )}
        {step === 'signIn' && (
          <SignIn
            auth={hostedAccount}
            onConsent={() => {
              startDownload();
              return grantDataConsent('hosted');
            }}
            onSignedIn={async (signedIn) => {
              await saveHostedSession(signedIn);
              // side panel 重新讀 session；SW 接著翻已啟動分頁裡還沒翻的頁
              void chrome.runtime.sendMessage({ type: 'session:changed' } satisfies Message).catch(() => {});
              setSession(signedIn);
              // 卡住來的、設定早就完成（只是登入失效）：登入就解決了
              go(from !== undefined && progress === 'done' ? 'return' : 'plan');
            }}
            emailFooter={back('intro')}
          />
        )}
        {step === 'plan' && session && (
          <>
            <Plan
              session={session}
              onChoose={startDownload}
              onFree={() => void saveTranslationMode('hosted').then(finish)}
              // 付款完成或本來就訂閱就算設定完成，就算沒按「下一步」就關掉分頁也一樣
              onSubscribed={() => void saveTranslationMode('hosted').then(complete)}
              onNext={() => setStep(afterSetup())}
            />
            {back('signIn')}
          </>
        )}
        {step === 'tutorial' && <TryPractice />}
        {step === 'return' && from !== undefined && <ReturnToManga from={from} />}
        {step === 'ownKey' && (
          <OwnKey
            onSaved={(key) => {
              startDownload();
              // key 先存好，同意與模式寫進 chrome.storage 時 SW 才翻得了已啟動的分頁
              void apiKeys
                .set(key)
                .then(() => grantDataConsent('ownKey'))
                .then(() => saveTranslationMode('ownKey'))
                .then(finish);
            }}
            onBack={() => go('intro')}
          />
        )}
      </main>
      {step !== 'ownKey' && step !== 'return' && (
        <p class="ob-foot">
          已經有 Anthropic API key？
          <Button variant="link" onClick={() => setStep('ownKey')}>
            使用自備金鑰
          </Button>
        </p>
      )}
      <DownloadPill status={modelStatus} started={downloadStarted} />
    </div>
  );
}

const { step: requested, from } = onboardingRequest(location.search);
render(<Onboarding requested={requested} from={from} />, document.getElementById('app')!);
