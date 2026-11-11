/**
 * 帳號與訂閱頁（#213，prototype/account-status 的方案 B）：所有帳號狀態的家。圖示右鍵選單「帳號與訂閱」直接打開；
 * 額度用完時 Page 上的紅色小標籤與點圖示帶著漫畫分頁打開（?from=N，「回到漫畫」切回去）；side panel 設定頁的「管理帳號 →」也到這裡。
 *
 * 由上到下：狀態說明（需要時）、付款中（需要時）、登入的帳號＋登出、目前方案（進度條畫剩下多少）、
 * 訂閱（只有免費方案；年繳、季繳兩張並排的卡片，#257）、刪除帳號。
 * 要顯示什麼由 view.ts 的 accountPageView 決定；這裡只接上 chrome、Worker 與畫面。
 */
import { Fragment, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { deleteAccount, signOut } from '../shared/account-exit.ts';
import { accountRequest } from '../shared/account-page.ts';
import { grantDataConsent } from '../shared/data-consent.ts';
import type { BillingPeriod } from '../shared/hosted-api.ts';
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
import { ownPaymentChange, watchPendingPayment, type PendingPayment } from '../shared/payment-return.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';
import { Badge, Button, Callout } from '../ui/components.tsx';
import { DeleteAccount } from '../ui/delete-account.tsx';
import { SignIn } from '../ui/sign-in.tsx';
import { OfferText, PaymentUnavailable } from '../ui/subscribe-button.tsx';
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

/**
 * 這一頁發起的付款：pending＝還在等的付款（SW 記的狀態），settled＝SW 清掉了（確認了或放棄）時那筆付款的扣款週期，
 * 由額度決定是不是「訂閱完成」。
 */
function useAccountPayment(): { pending: PendingPayment | undefined; settled: BillingPeriod | undefined } {
  const [state, setState] = useState<{ pending: PendingPayment | undefined; settled: BillingPeriod | undefined }>({ pending: undefined, settled: undefined });
  useEffect(() => {
    let previous: PendingPayment | undefined;
    return watchPendingPayment((next) => {
      const { mine, action } = ownPaymentChange('account', previous, next);
      if (action === 'wait') setState({ pending: mine, settled: undefined });
      if (action === 'settled') setState({ pending: undefined, settled: previous?.billingPeriod });
      previous = mine;
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
    payment: payment.pending && { billingPeriod: payment.pending.billingPeriod, checkoutClosed: payment.pending.checkoutTabId === null },
    justPaid: quota?.plan === 'subscribed' ? payment.settled : undefined,
    justSignedIn,
    hasOrigin: from !== undefined,
  });
  const plan = quota && accountPlanView(quota);
  /** 打開這個扣款週期的付款頁：付款分頁還開著的話 SW 切過去，不開第二個。 */
  const pay = (billingPeriod: BillingPeriod) => runPayment(() => subscribe(session, 'account', billingPeriod));
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
      {view.payment && (
        <Callout tone="info" class="naru-callout--stack" role="status" aria-label={view.payment.title}>
          <p>
            <strong>{view.payment.title}</strong>
          </p>
          <p>
            {view.payment.chosen && (
              <>
                你選的是 <OfferText offer={view.payment.chosen} />。
              </>
            )}
            {view.payment.body}
          </p>
          <div>
            <Button onClick={() => pay(view.payment!.billingPeriod)}>{view.payment.button}</Button>
          </div>
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
          <p>{view.subscribe.headline}</p>
          <div class="ac-offers">
            {view.subscribe.offers.map((offer) => (
              <div key={offer.billingPeriod} class={offer.recommended ? 'ac-offer ac-offer--recommended' : 'ac-offer'}>
                {offer.recommended ? <Badge tone="solid">推薦</Badge> : <span class="ac-offer__badge-space" aria-hidden="true" />}
                <p class="ac-offer__price">
                  <OfferText offer={offer} />
                </p>
                <Button variant={offer.recommended ? 'primary' : 'secondary'} class="ac-big ac-offer__button" onClick={() => pay(offer.billingPeriod)}>
                  {offer.subscribe}
                </Button>
              </div>
            ))}
          </div>
          <p class="hint">{view.subscribe.note}</p>
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
