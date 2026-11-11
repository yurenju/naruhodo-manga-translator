/**
 * 付款後回到外掛（#176，流程定案於 prototype/payment-return）：onboarding 與帳號頁的「訂閱」都請 SW 開付款分頁，
 * SW 記住「付款分頁 → 發起付款的分頁」，付款確認或付款分頁被關掉時把讀者帶回發起的分頁。
 * Chrome API 都從 deps 注入，SW 的 index.ts 負責接上真的 chrome.*。用到的 chrome.tabs 都不需要 tabs 權限。
 */
import type { BillingPeriod } from '../shared/hosted-api.ts';
import type { PaymentFrom, PendingPayment } from '../shared/payment-return.ts';

export interface PaymentReturnDeps {
  load(): Promise<PendingPayment | undefined>;
  save(pending: PendingPayment | undefined): Promise<void>;
  /** 開新分頁並切過去，回傳 tab id。 */
  createTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  /** 切到這個分頁（連同它的視窗）；分頁已經不在了回傳 false。 */
  focusTab(tabId: number): Promise<boolean>;
  isActiveTab(tabId: number): Promise<boolean>;
  /** 向 Worker 查這個帳號是不是訂閱中；沒登入、連不上都當作不是。 */
  isSubscribed(): Promise<boolean>;
  /** 付款確認了：通知 onboarding、帳號頁與 side panel；billingPeriod 是付款分頁那筆 transaction 的。 */
  onConfirmed(from: PaymentFrom, billingPeriod: BillingPeriod): void;
  now(): number;
}

/** 付款分頁被關掉之後再查這麼久；讀者可能付完款才關，webhook 還在路上。 */
const GIVE_UP_MS = 10 * 60_000;

export function createPaymentReturn(deps: PaymentReturnDeps) {
  /**
   * open、tabRemoved、check 都是讀了付款狀態再寫回去，一次只跑一個：
   * 不然 check 清掉狀態的同時讀者關掉付款分頁，tabRemoved 會把舊狀態寫回去。
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function open({ url, originTabId, from, billingPeriod }: { url: string; originTabId: number; from: PaymentFrom; billingPeriod: BillingPeriod }): Promise<void> {
    return serial(async () => {
      const pending = await deps.load();
      // 重複按「訂閱」：Worker 給的是新的 transaction，但已經開著的付款頁一樣能付，不開第二個；付完帶回最後按的那一邊。
      // 扣款週期照那個付款頁的（讀者在那頁付的是它的 price）
      if (pending?.checkoutTabId != null && (await deps.focusTab(pending.checkoutTabId))) {
        await deps.save({ ...pending, originTabId, from });
        return;
      }
      const checkoutTabId = await deps.createTab(url);
      await deps.save({ checkoutTabId, originTabId, from, billingPeriod });
    });
  }

  /**
   * 每個視窗正在看的分頁（chrome.tabs.onActivated）。onRemoved 不說被關掉的是不是正在看的分頁，只能自己記。
   * Chrome 關掉正在看的分頁時，先送 onRemoved 才送鄰近分頁的 onActivated，所以 tabRemoved 一開始讀到的還是被關掉的那個。
   */
  const activeByWindow = new Map<number, number>();

  function tabActivated(tabId: number, windowId: number): void {
    activeByWindow.set(windowId, tabId);
  }

  function tabRemoved(tabId: number, windowId: number): Promise<void> {
    // 在排隊之前讀，不然鄰近分頁的 onActivated 已經蓋掉了
    const wasActive = activeByWindow.get(windowId) === tabId;
    return serial(async () => {
      const pending = await deps.load();
      if (pending?.checkoutTabId !== tabId) return;
      await deps.save({ ...pending, checkoutTabId: null, closedAt: deps.now() });
      if (wasActive) await deps.focusTab(pending.originTabId);
    });
  }

  /** 查一次付款；回傳還要不要繼續查。 */
  const check = () => serial(checkOnce);

  async function checkOnce(): Promise<boolean> {
    const pending = await deps.load();
    if (!pending) return false;
    if (!(await deps.isSubscribed())) {
      if (pending.closedAt === undefined || deps.now() - pending.closedAt < GIVE_UP_MS) return true;
      await deps.save(undefined);
      return false;
    }
    // 先清掉再關分頁：關分頁觸發的 tabRemoved 看到沒有待確認的付款，不會再切一次
    await deps.save(undefined);
    if (pending.checkoutTabId !== null) {
      // 讀者正在看付款分頁才切回去；他已經去看別的分頁就不打擾，只把付款分頁收掉
      const watching = await deps.isActiveTab(pending.checkoutTabId);
      await deps.closeTab(pending.checkoutTabId);
      if (watching) await deps.focusTab(pending.originTabId);
    }
    deps.onConfirmed(pending.from, pending.billingPeriod);
    return false;
  }

  return { open, tabActivated, tabRemoved, check };
}
