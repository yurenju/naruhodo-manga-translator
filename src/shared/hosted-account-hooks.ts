/**
 * 外掛頁面（side panel、帳號與訂閱頁 #213）共用的 Hosted Translation 帳號狀態與動作：session、剩餘額度、
 * 「訂閱」「管理訂閱」「申請退款」「登出」「刪除帳號」。畫面在各自的頁面，這裡只有 hooks 與呼叫 Worker 的動作。
 */
import { useEffect, useState } from 'preact/hooks';
import type { AccountExitDeps } from './account-exit.ts';
import { createHostedAccountClient } from './hosted-account-client.ts';
import type { AccountResponse, BillingPeriod, Quota } from './hosted-api.ts';
import { clearHostedSession, HOSTED_API_URL, loadHostedSession, type HostedSession } from './hosted-session.ts';
import type { Message } from './messages.ts';
import { openPayment, type PaymentFrom } from './payment-return.ts';
import { watchTranslationMode, type TranslationMode } from './translation-mode.ts';

export const hostedAccount = createHostedAccountClient({ apiUrl: HOSTED_API_URL, fetch: (url, init) => fetch(url, init) });

/** 這一頁自己改了 session：runtime 訊息不會送回給發送的一方，自己的 useHostedSession 另外通知。 */
const sessionChangedHere = new EventTarget();

/** 這一頁登入了（onboarding 以外的地方，例如帳號頁）：存好 session 之後廣播給 SW 與其他頁面，也通知自己。 */
export function broadcastSessionChanged(): void {
  sessionChangedHere.dispatchEvent(new Event('change'));
  void chrome.runtime.sendMessage({ type: 'session:changed' } satisfies Message).catch(() => {});
}

/** 登出、刪除帳號之後：清掉本機的 session，廣播給 SW 與其他頁面，也通知自己。 */
export const accountExit: AccountExitDeps = {
  auth: hostedAccount,
  clearSession: () => clearHostedSession().then(() => {}),
  broadcast: broadcastSessionChanged,
};

/** undefined＝還在讀。 */
export function useTranslationMode(): TranslationMode | undefined {
  const [mode, setMode] = useState<TranslationMode | undefined>(undefined);
  useEffect(() => watchTranslationMode(setMode), []);
  return mode;
}

/**
 * Hosted Translation 的 session（IndexedDB）；undefined＝還在讀，null＝沒登入。
 * onboarding 頁登入、或 SW 發現 token 失效而清掉時，收到 session:changed 重新讀；這一頁自己登入、登出、刪除帳號時也重新讀。
 */
export function useHostedSession(): HostedSession | null | undefined {
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

/** 這一頁自己改了額度（申請退款之後）：runtime 訊息不會送回給發送的一方，自己的 useHostedAccount 另外通知。 */
const quotaChangedHere = new EventTarget();

/**
 * 內建翻譯的帳號狀態（GET /v1/account：剩餘額度與退款資訊，#92、#260）：登入後向 Worker 讀；SW 說額度變了（翻譯扣了一頁、Worker 說用完、付款確認）就重新讀。
 * 頁面重新取得焦點、或重新變成可見時也重讀（#94）：在新分頁付完款回來，就看到已訂閱。side panel 跟著漫畫分頁，
 * 切到付款分頁時它被隱藏，切回來時不一定有 focus 事件，所以兩個都聽。
 * 沒登入或讀不到時是 undefined（token 失效由 SW 的 Hosted Translator 處理，這裡不管）。
 */
export function useHostedAccount(session: HostedSession | null | undefined): AccountResponse | undefined {
  const [account, setAccount] = useState<AccountResponse | undefined>(undefined);
  const token = session?.token;
  useEffect(() => {
    setAccount(undefined);
    if (!token) return;
    let current = true;
    const refresh = () =>
      void hostedAccount.account(token).then((r) => {
        if (current && r.ok) setAccount(r.account);
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
    quotaChangedHere.addEventListener('change', refresh);
    refresh();
    return () => {
      current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
      quotaChangedHere.removeEventListener('change', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);
  return account;
}

/** 剩餘額度（useHostedAccount 的 quota）。 */
export const useHostedQuota = (session: HostedSession | null | undefined): Quota | undefined => useHostedAccount(session)?.quota;

/**
 * 「確定退款」（#260）：向 Worker 申請全額退款，成功或被拒（狀態已經變了）都重讀帳號狀態、通知其他頁面。
 * 成功回 true；畫面換成「退款處理中」由重讀到的 refund 決定。
 */
export async function requestRefund(session: HostedSession): Promise<boolean> {
  const result = await hostedAccount.refund(session.token);
  if (!result.ok) console.error('申請退款失敗', result.message);
  quotaChangedHere.dispatchEvent(new Event('change'));
  void chrome.runtime.sendMessage({ type: 'quota:changed' } satisfies Message).catch(() => {});
  return result.ok;
}

/**
 * 「訂閱」：向 Worker 建立這個 Billing Period 的 checkout，請 SW 用新分頁打開產品網站的 checkout 頁（#94），付款後 SW 帶讀者回到發起的分頁（#176）。
 * 付款分頁還開著的話 SW 切過去，不開第二個。已經訂閱中就重讀額度。失敗回 false。
 * tabId＝side panel 跟著的分頁；沒給時用這個分頁或這個視窗正在看的分頁（openPayment）。
 */
export async function subscribe(session: HostedSession, from: PaymentFrom, billingPeriod: BillingPeriod, tabId?: number): Promise<boolean> {
  const result = await hostedAccount.checkout(session.token, 'zh-tw', billingPeriod);
  if (result.ok) void openPayment(result.url, from, billingPeriod, tabId);
  else if (result.reason === 'alreadySubscribed') void chrome.runtime.sendMessage({ type: 'quota:changed' } satisfies Message).catch(() => {});
  else {
    console.error('建立 checkout 失敗', result.message);
    return false;
  }
  return true;
}

/** 「管理訂閱」：向 Worker 建立 Paddle customer portal session，用新分頁打開（取消訂閱、更新付款方式、收據）。失敗回 false。 */
export async function managePlan(session: HostedSession): Promise<boolean> {
  const result = await hostedAccount.portal(session.token);
  if (result.ok) void chrome.tabs.create({ url: result.url });
  else console.error('打開 customer portal 失敗', result.message);
  return result.ok;
}

/** 「訂閱」「管理訂閱」的按鈕：失敗時記下來讓畫面顯示錯誤（#156），再按一次先清掉。 */
export function usePaymentAction(): [failed: boolean, run: (action: () => Promise<boolean>) => void] {
  const [failed, setFailed] = useState(false);
  const run = (action: () => Promise<boolean>) => {
    setFailed(false);
    void action().then((ok) => setFailed(!ok));
  };
  return [failed, run];
}
