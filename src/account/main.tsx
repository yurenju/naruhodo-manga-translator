/**
 * 帳號與訂閱頁（#213，prototype/account-status 的方案 B）：所有帳號狀態的家。圖示右鍵選單「帳號與訂閱」直接打開；
 * 額度用完時 Page 上的紅色小標籤與點圖示帶著漫畫分頁打開（?from=N，「回到漫畫」切回去）；side panel 設定頁的「管理帳號 →」也到這裡。
 *
 * 由上到下：狀態說明（需要時）、登入的帳號＋登出、目前方案（進度條畫剩下多少）、訂閱（只有免費方案）、刪除帳號。
 * 要顯示什麼由 view.ts 的 accountPageView 決定；這裡只接上 chrome、Worker 與畫面。
 */
import { Fragment, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { deleteAccount, signOut } from '../shared/account-exit.ts';
import { accountRequest } from '../shared/account-page.ts';
import { grantDataConsent } from '../shared/data-consent.ts';
import { MONTHLY_PAGES, pageCount } from '../shared/hosted-api.ts';
import {
  accountExit,
  broadcastSessionChanged,
  hostedAccount,
  managePlan,
  subscribe,
  useHostedQuota,
  useHostedSession,
  usePaymentAction,
  useTranslationMode,
} from '../shared/hosted-account-hooks.ts';
import { saveHostedSession, type HostedSession } from '../shared/hosted-session.ts';
import type { Message } from '../shared/messages.ts';
import { ownPaymentChange, watchPendingPayment } from '../shared/payment-return.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';
import { Badge, Button, Callout } from '../ui/components.tsx';
import { DeleteAccount } from '../ui/delete-account.tsx';
import { SignIn } from '../ui/sign-in.tsx';
import { PaymentUnavailable, SubscribeButton, SubscriptionPrice } from '../ui/subscribe-button.tsx';
import { accountPageView, accountPlanView, signedOutText } from '../ui/view.ts';

const LOGO = 'icons/naruhodo-small.svg';

const { from } = accountRequest(location.search);

/** 「回到漫畫」：SW 切回那個分頁、接著翻還沒翻的頁（跟 onboarding 的「回到漫畫」同一個訊息），然後關掉這一頁。 */
function backToManga(tabId: number) {
  void chrome.runtime
    .sendMessage({ type: 'onboarding:return', tabId } satisfies Message)
    .catch(() => {})
    .then(() => window.close());
}

/** 這一頁發起的付款：paying＝還在等付款分頁，settled＝SW 清掉了（確認了或放棄），由額度決定是不是「訂閱完成」。 */
function useAccountPayment(): { paying: boolean; settled: boolean } {
  const [state, setState] = useState({ paying: false, settled: false });
  useEffect(() => {
    let previous: Parameters<typeof ownPaymentChange>[1];
    return watchPendingPayment((next) => {
      const { mine, action } = ownPaymentChange('account', previous, next);
      previous = mine;
      if (action === 'wait') setState({ paying: true, settled: false });
      if (action === 'settled') setState({ paying: false, settled: true });
    });
  }, []);
  return state;
}

function SignedOut({ text, onSignedIn }: { text: string; onSignedIn: () => void }) {
  const [signingIn, setSigningIn] = useState(false);
  if (signingIn)
    return (
      <SignIn
        auth={hostedAccount}
        onConsent={() => grantDataConsent('hosted')}
        onSignedIn={async (signedIn) => {
          await saveHostedSession(signedIn);
          broadcastSessionChanged();
          onSignedIn();
        }}
        emailFooter={
          <p class="ac-back">
            <Button variant="link" onClick={() => setSigningIn(false)}>
              ← 取消
            </Button>
          </p>
        }
      />
    );
  return (
    <>
      <p>{text}</p>
      <div>
        <Button variant="primary" class="ac-big" onClick={() => setSigningIn(true)}>
          登入
        </Button>
      </div>
    </>
  );
}

function Account({ session, mode, justSignedIn }: { session: HostedSession; mode: TranslationMode; justSignedIn: boolean }) {
  const quota = useHostedQuota(session);
  const payment = useAccountPayment();
  const [paymentFailed, runPayment] = usePaymentAction();
  const [deleting, setDeleting] = useState<'confirm' | 'busy' | undefined>(undefined);
  const [deleteFailed, setDeleteFailed] = useState(false);

  if (deleting)
    return (
      <DeleteAccount
        email={session.email}
        deleting={deleting === 'busy'}
        failed={deleteFailed}
        onConfirm={() => {
          setDeleting('busy');
          setDeleteFailed(false);
          void deleteAccount(accountExit, session.token).then((result) => {
            if (result.ok) return;
            console.error('刪除帳號失敗', result.message);
            setDeleting('confirm');
            setDeleteFailed(true);
          });
        }}
        onCancel={() => setDeleting(undefined)}
      />
    );

  const view = accountPageView({
    mode,
    signedIn: true,
    quota,
    justPaid: payment.settled && quota?.plan === 'subscribed',
    justSignedIn,
    hasOrigin: from !== undefined,
  });
  const plan = quota && accountPlanView(quota);
  return (
    <>
      {view.notice && (
        <Callout tone={view.notice.tone} class="naru-callout--stack" role="status">
          <p>
            <strong>{view.notice.title}</strong>
          </p>
          <p>{view.notice.body}</p>
          {view.notice.backToManga && from !== undefined && (
            <div>
              <Button variant={view.notice.tone === 'info' ? 'primary' : 'secondary'} onClick={() => backToManga(from)}>
                回到漫畫
              </Button>
            </div>
          )}
        </Callout>
      )}
      {payment.paying && (
        <Callout tone="info" role="status">
          <p>付款頁已經在另一個分頁打開（由 Paddle 處理付款）。付款完成後，會自動帶你回到這裡。</p>
        </Callout>
      )}
      {view.ownKeyNote && (
        <Callout tone="info">
          <p>目前用自備金鑰翻譯，不會用到這個帳號的頁數。</p>
        </Callout>
      )}
      <section class="ac-sec" aria-label="登入的帳號">
        <h2>登入的帳號</h2>
        <div class="ac-split">
          <strong>{session.email}</strong>
          <Button onClick={() => void signOut(accountExit, session.token)}>登出</Button>
        </div>
      </section>
      {view.plan && plan && (
        <section class="ac-sec" aria-label="目前方案">
          <h2>目前方案</h2>
          <div class="ac-plan-head">
            <span class="ac-plan-name">{view.plan.name}</span>
            {quota?.plan === 'subscribed' ? <Badge tone={plan.badge.tone}>{plan.badge.text}</Badge> : <span class="hint">{view.plan.note}</span>}
          </div>
          <div class="ac-split ac-small">
            <span class="ac-muted">{view.plan.quotaLabel}</span>
            <span class={view.plan.warn ? 'ac-warn' : undefined}>{view.plan.left}</span>
          </div>
          <div class={view.plan.warn ? 'ac-meter ac-meter--warn' : 'ac-meter'} role="presentation">
            <i style={{ width: `${Math.round(view.plan.fraction * 100)}%` }} />
          </div>
          {quota?.plan === 'subscribed' && (
            <>
              <p class="hint">
                {plan.lines.map((line, i) => (
                  <Fragment key={line}>
                    {i > 0 && <br />}
                    {line}
                  </Fragment>
                ))}
              </p>
              <div>
                <Button onClick={() => runPayment(() => managePlan(session))}>管理訂閱（付款方式、取消）</Button>
              </div>
            </>
          )}
        </section>
      )}
      {view.subscribe && (
        <section class="ac-sec" aria-label="訂閱">
          <h2>訂閱</h2>
          <p>每月可翻 {pageCount(MONTHLY_PAGES)} 頁，從訂閱那天起每月同一天重置。隨時取消，用到這一年結束。</p>
          <SubscriptionPrice />
          <div>
            <SubscribeButton variant="primary" onSubscribe={() => runPayment(() => subscribe(session, 'account'))} />
          </div>
        </section>
      )}
      {paymentFailed && <PaymentUnavailable />}
      <section class="ac-sec ac-end" aria-label="刪除帳號">
        <Button variant="ghost" class="naru-text-danger" onClick={() => setDeleting('confirm')}>
          刪除帳號
        </Button>
      </section>
    </>
  );
}

function App() {
  const session = useHostedSession();
  const mode = useTranslationMode();
  /** 在這一頁登入了：從漫畫來的顯示「✓ 已登入」與「回到漫畫」。 */
  const [justSignedIn, setJustSignedIn] = useState(false);
  if (session === undefined || mode === undefined) return null;
  return (
    <div class="ac">
      <header class="ac-brand">
        <img src={LOGO} alt="" width={24} height={24} />
        Naruhodo
      </header>
      <main class="ac-card">
        <h1 class="ac-h1">帳號與訂閱</h1>
        {session ? (
          <Account key={session.token} session={session} mode={mode} justSignedIn={justSignedIn} />
        ) : (
          <SignedOut
            text={signedOutText(mode)}
            onSignedIn={() => setJustSignedIn(true)}
          />
        )}
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
