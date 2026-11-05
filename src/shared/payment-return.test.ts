import { describe, expect, it } from 'vitest';
import { paymentChange, type PendingPayment } from './payment-return.ts';

const fromOnboarding: PendingPayment = { checkoutTabId: 3, originTabId: 1, from: 'onboarding' };
const fromPanel: PendingPayment = { checkoutTabId: 3, originTabId: 2, from: 'panel' };

describe('paymentChange', () => {
  it('onboarding 發起的付款還在：等付款（付款分頁被關掉了也一樣）', () => {
    expect(paymentChange('onboarding', undefined, fromOnboarding)).toEqual({ mine: fromOnboarding, action: 'wait' });
    const closed = { ...fromOnboarding, checkoutTabId: null, closedAt: 1000 };
    expect(paymentChange('onboarding', fromOnboarding, closed)).toEqual({ mine: closed, action: 'wait' });
  });

  it('本來在等、SW 清掉了：去讀方案決定結果', () => {
    expect(paymentChange('onboarding', fromOnboarding, undefined)).toEqual({ mine: undefined, action: 'settled' });
  });

  it('打開 onboarding 時沒有付款：什麼都不做', () => {
    expect(paymentChange('onboarding', undefined, undefined)).toEqual({ mine: undefined, action: 'none' });
  });

  it('side panel 發起的付款不關 onboarding 的事；從 onboarding 換成 side panel 發起，等於 onboarding 這邊結束了', () => {
    expect(paymentChange('onboarding', undefined, fromPanel)).toEqual({ mine: undefined, action: 'none' });
    expect(paymentChange('onboarding', fromOnboarding, fromPanel)).toEqual({ mine: undefined, action: 'settled' });
  });

  it('帳號頁只看帳號頁發起的付款（#213）', () => {
    const fromAccount: PendingPayment = { checkoutTabId: 3, originTabId: 4, from: 'account' };
    expect(paymentChange('account', undefined, fromAccount)).toEqual({ mine: fromAccount, action: 'wait' });
    expect(paymentChange('account', fromAccount, undefined)).toEqual({ mine: undefined, action: 'settled' });
    expect(paymentChange('account', undefined, fromOnboarding)).toEqual({ mine: undefined, action: 'none' });
    expect(paymentChange('onboarding', undefined, fromAccount)).toEqual({ mine: undefined, action: 'none' });
  });
});

