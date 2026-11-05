/**
 * 付款後回到外掛（#176）：SW 開付款分頁時記下的狀態，存在 chrome.storage.session（SW 被回收再起來也接得上，瀏覽器重開就清掉）。
 * SW 寫（background/payment-return.ts），onboarding 讀它決定第 3 步顯示「在付款分頁完成付款」還是「付款頁已經關閉」，帳號頁讀它決定要不要顯示「訂閱完成」，
 * side panel 讀「已訂閱」提示要不要顯示。
 */
import type { Message } from './messages.ts';
import { watchStorage } from './watch-local.ts';

/** 誰按了「訂閱」：onboarding 第 3 步、side panel（剩餘額度），或帳號與訂閱頁（#213）。 */
export type PaymentFrom = Extract<Message, { type: 'payment:open' }>['from'];

export interface PendingPayment {
  /** 付款分頁；null＝已經被關掉，SW 還在查付款有沒有完成。 */
  checkoutTabId: number | null;
  /** 發起付款的分頁：付款確認或付款分頁被關掉時切回這裡。 */
  originTabId: number;
  from: PaymentFrom;
  /** 付款分頁被關掉的時間（ms）；SW 從這時候起再查一段時間就放棄。 */
  closedAt?: number;
}

const PENDING_KEY = 'pendingPayment';
/** true＝side panel 發起的付款確認了，side panel 顯示一次「已訂閱」。 */
const NOTICE_KEY = 'subscribedNotice';

/**
 * 自己發起付款的頁面（onboarding 第 3 步、帳號頁）看 SW 記的付款狀態變了要做什麼。只看 owner 發起的付款（別人發起的不關它的事）：
 * wait＝還在等付款（重新打開這一頁時付款還沒確認，也接著等）；settled＝本來在等、SW 清掉了（確認了，或關掉付款分頁 10 分鐘後放棄），
 * 向 Worker 讀一次方案決定是「訂閱完成」還是回到原本的畫面。mine＝之後要當 previous 傳回來的值。
 */
export function paymentChange(
  owner: Exclude<PaymentFrom, 'panel'>,
  previous: PendingPayment | undefined,
  next: PendingPayment | undefined,
): { mine: PendingPayment | undefined; action: 'wait' | 'settled' | 'none' } {
  const mine = next?.from === owner ? next : undefined;
  if (mine) return { mine, action: 'wait' };
  return { mine, action: previous ? 'settled' : 'none' };
}

/**
 * 請 SW 開付款分頁。originTabId 沒給時：onboarding、帳號頁是自己這個分頁，side panel 是這個視窗正在看的分頁（它跟著的漫畫分頁）。
 */
export async function openPayment(url: string, from: PaymentFrom, originTabId?: number): Promise<void> {
  const origin = originTabId ?? (await chrome.tabs.getCurrent())?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  // 找不到發起的分頁、或 SW 沒回應（幾乎不會發生）：照舊只開付款頁，不帶回去
  const fallback = () => chrome.tabs.create({ url }).then(() => {});
  if (origin === undefined) return fallback();
  await chrome.runtime.sendMessage({ type: 'payment:open', url, originTabId: origin, from } satisfies Message).catch(fallback);
}

export async function loadPendingPayment(): Promise<PendingPayment | undefined> {
  return (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as PendingPayment | undefined;
}

export function savePendingPayment(pending: PendingPayment | undefined): Promise<void> {
  return pending ? chrome.storage.session.set({ [PENDING_KEY]: pending }) : chrome.storage.session.remove(PENDING_KEY);
}

export const watchPendingPayment = (onChange: (pending: PendingPayment | undefined) => void) =>
  watchStorage('session', PENDING_KEY, (value) => value as PendingPayment | undefined, onChange);

export function showSubscribedNotice(): Promise<void> {
  return chrome.storage.session.set({ [NOTICE_KEY]: true });
}

export function dismissSubscribedNotice(): Promise<void> {
  return chrome.storage.session.remove(NOTICE_KEY);
}

export const watchSubscribedNotice = (onChange: (show: boolean) => void) => watchStorage('session', NOTICE_KEY, (value) => value === true, onChange);
