import { describe, expect, it } from 'vitest';
import type { BillingPeriod } from '../shared/hosted-api.ts';
import type { PendingPayment } from '../shared/payment-return.ts';
import { createPaymentReturn, type PaymentReturnDeps } from './payment-return.ts';

const CHECKOUT_URL = 'https://naruhodo.example/zh-tw/checkout?_ptxn=txn_1';
const ONBOARDING = 1;
const MANGA = 2;
const WINDOW = 10;

/** 用記憶體模擬 Chrome 的分頁（一個視窗）、chrome.storage.session 與 Worker 的方案。 */
function fakeChrome() {
  let tabs = [ONBOARDING, MANGA];
  let active: number | undefined = ONBOARDING;
  let nextId = 3;
  let pending: PendingPayment | undefined;
  /** gate：Worker 回答方案之前要等它（模擬查到一半）。 */
  const world = { subscribed: false, now: 0, confirmed: [] as string[], confirmedPeriod: undefined as BillingPeriod | undefined, gate: Promise.resolve() };
  let paymentReturn: ReturnType<typeof createPaymentReturn>;

  /** 分頁被關掉：Chrome 先送 onRemoved，正在看的分頁被關掉時再切到鄰近的分頁。 */
  function remove(tabId: number): Promise<void> {
    const wasActive = active === tabId;
    tabs = tabs.filter((t) => t !== tabId);
    const removed = paymentReturn.tabRemoved(tabId, WINDOW);
    if (wasActive) activate(tabs.at(-1)!);
    return removed;
  }
  function activate(tabId: number) {
    active = tabId;
    paymentReturn.tabActivated(tabId, WINDOW);
  }

  const deps: PaymentReturnDeps = {
    load: async () => pending,
    save: async (p) => void (pending = p),
    createTab: async () => {
      const id = nextId++;
      tabs.push(id);
      activate(id);
      return id;
    },
    // 真的 chrome.tabs.remove 不等 onRemoved 的 listener 跑完
    closeTab: async (tabId) => void remove(tabId),
    focusTab: async (tabId) => {
      if (!tabs.includes(tabId)) return false;
      activate(tabId);
      return true;
    },
    isActiveTab: async (tabId) => active === tabId,
    isSubscribed: async () => {
      await world.gate;
      return world.subscribed;
    },
    onConfirmed: (from, billingPeriod) => {
      world.confirmed.push(from);
      world.confirmedPeriod = billingPeriod;
    },
    now: () => world.now,
  };
  paymentReturn = createPaymentReturn(deps);
  paymentReturn.tabActivated(ONBOARDING, WINDOW);
  return {
    paymentReturn,
    world,
    tabs: () => tabs,
    active: () => active,
    pending: () => pending,
    /** 讀者自己切分頁、開新分頁、按 ✕ 關分頁。 */
    reader: {
      switchTo: activate,
      openTab: () => deps.createTab('https://news.example/'),
      close: remove,
    },
  };
}

describe('open', () => {
  it('開付款分頁、切過去，記住它是從哪個分頁發起的', async () => {
    const chrome = fakeChrome();

    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });

    expect(chrome.tabs()).toEqual([ONBOARDING, MANGA, 3]);
    expect(chrome.active()).toBe(3);
    expect(chrome.pending()).toEqual({ checkoutTabId: 3, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
  });

  it('付款分頁還開著時又按「訂閱」：切到那個付款分頁，不開第二個', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    chrome.reader.switchTo(ONBOARDING);

    await chrome.paymentReturn.open({ url: 'https://naruhodo.example/zh-tw/checkout?_ptxn=txn_2', originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });

    expect(chrome.tabs()).toEqual([ONBOARDING, MANGA, 3]);
    expect(chrome.active()).toBe(3);
  });

  it('付款分頁是帳號頁開的，又在 onboarding 按「訂閱」：沿用那個分頁，之後帶回 onboarding', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: MANGA, from: 'account', billingPeriod: 'yearly' });

    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });

    expect(chrome.pending()).toEqual({ checkoutTabId: 3, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
  });
  it('付款分頁還開著時改選另一種扣款週期：切到那個付款分頁，記的還是那個分頁的扣款週期', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'account', billingPeriod: 'yearly' });

    await chrome.paymentReturn.open({ url: 'https://naruhodo.example/zh-tw/checkout?_ptxn=txn_2', originTabId: ONBOARDING, from: 'account', billingPeriod: 'quarterly' });

    expect(chrome.pending()).toEqual({ checkoutTabId: 3, originTabId: ONBOARDING, from: 'account', billingPeriod: 'yearly' });
  });

  it('付款分頁關掉之後改選另一種扣款週期：開新的付款分頁，記新的扣款週期', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'account', billingPeriod: 'yearly' });
    await chrome.reader.close(3);

    await chrome.paymentReturn.open({ url: 'https://naruhodo.example/zh-tw/checkout?_ptxn=txn_2', originTabId: ONBOARDING, from: 'account', billingPeriod: 'quarterly' });

    expect(chrome.pending()).toEqual({ checkoutTabId: 4, originTabId: ONBOARDING, from: 'account', billingPeriod: 'quarterly' });
  });
});

describe('check：每 3 秒查一次付款', () => {
  it('還沒付款：什麼都不動，繼續查', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });

    expect(await chrome.paymentReturn.check()).toBe(true);
    expect(chrome.tabs()).toEqual([ONBOARDING, MANGA, 3]);
    expect(chrome.world.confirmed).toEqual([]);
  });

  it('讀者正在看付款分頁時確認付款：關掉付款分頁、切回發起的分頁，不再查', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    chrome.world.subscribed = true;

    expect(await chrome.paymentReturn.check()).toBe(false);

    expect(chrome.tabs()).toEqual([ONBOARDING, MANGA]);
    expect(chrome.active()).toBe(ONBOARDING);
    expect(chrome.pending()).toBeUndefined();
    expect(chrome.world.confirmed).toEqual(['onboarding']);
  });

  it('讀者付完款去看別的分頁：只把付款分頁收掉，不把他切走', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    const other = await chrome.reader.openTab();
    chrome.world.subscribed = true;

    await chrome.paymentReturn.check();

    expect(chrome.tabs()).toEqual([ONBOARDING, MANGA, other]);
    expect(chrome.active()).toBe(other);
    expect(chrome.world.confirmed).toEqual(['onboarding']);
  });

  it('發起的分頁已經被關掉：只關付款分頁，停在 Chrome 選的鄰近分頁', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    await chrome.reader.close(ONBOARDING);
    chrome.world.subscribed = true;

    await chrome.paymentReturn.check();

    expect(chrome.tabs()).toEqual([MANGA]);
    expect(chrome.active()).toBe(MANGA);
  });

  it('確認了：通知付款分頁的扣款週期（付款中改選另一種、付款分頁還開著時，讀者付的還是原本那一種）', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: MANGA, from: 'account', billingPeriod: 'quarterly' });
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: MANGA, from: 'account', billingPeriod: 'yearly' });
    chrome.world.subscribed = true;

    await chrome.paymentReturn.check();

    expect(chrome.world.confirmed).toEqual(['account']);
    expect(chrome.world.confirmedPeriod).toBe('quarterly');
  });
});

describe('讀者自己關掉付款分頁', () => {
  it('關掉正在看的付款分頁：切回發起的分頁，繼續查，確認了照樣通知', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: MANGA, from: 'account', billingPeriod: 'yearly' });
    chrome.world.now = 1000;

    await chrome.reader.close(3);

    expect(chrome.active()).toBe(MANGA);
    expect(chrome.pending()).toEqual({ checkoutTabId: null, originTabId: MANGA, from: 'account', billingPeriod: 'yearly', closedAt: 1000 });
    expect(await chrome.paymentReturn.check()).toBe(true);
    chrome.world.subscribed = true;
    expect(await chrome.paymentReturn.check()).toBe(false);
    expect(chrome.world.confirmed).toEqual(['account']);
    expect(chrome.active()).toBe(MANGA);
  });

  it('從分頁列關掉背景的付款分頁：不切換', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    chrome.reader.switchTo(MANGA);

    await chrome.reader.close(3);

    expect(chrome.active()).toBe(MANGA);
    expect(chrome.pending()?.checkoutTabId).toBeNull();
  });

  it('關掉 10 分鐘後還沒確認：放棄，不再查', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    await chrome.reader.close(3);

    chrome.world.now = 10 * 60_000 - 1;
    expect(await chrome.paymentReturn.check()).toBe(true);
    chrome.world.now = 10 * 60_000;
    expect(await chrome.paymentReturn.check()).toBe(false);
    expect(chrome.pending()).toBeUndefined();
    expect(chrome.world.confirmed).toEqual([]);
  });

  it('SW 正在查付款時讀者關掉付款分頁，查到已訂閱：不留下付款狀態', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
    chrome.world.subscribed = true;
    let answer!: () => void;
    chrome.world.gate = new Promise((resolve) => (answer = resolve));

    const checking = chrome.paymentReturn.check();
    await Promise.resolve();
    const closing = chrome.reader.close(3);
    answer();
    await Promise.all([checking, closing]);

    expect(chrome.pending()).toBeUndefined();
    expect(chrome.world.confirmed).toEqual(['onboarding']);
  });

  it('別的分頁被關掉：不影響付款', async () => {
    const chrome = fakeChrome();
    await chrome.paymentReturn.open({ url: CHECKOUT_URL, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });

    await chrome.reader.close(MANGA);

    expect(chrome.pending()).toEqual({ checkoutTabId: 3, originTabId: ONBOARDING, from: 'onboarding', billingPeriod: 'yearly' });
  });
});
