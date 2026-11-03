import { describe, expect, it } from 'vitest';
import { onboardingPaymentChange, type PendingPayment } from './payment-return.ts';

const fromOnboarding: PendingPayment = { checkoutTabId: 3, originTabId: 1, from: 'onboarding' };
const fromPanel: PendingPayment = { checkoutTabId: 3, originTabId: 2, from: 'panel' };

describe('onboardingPaymentChange', () => {
  it('onboarding 發起的付款還在：等付款（付款分頁被關掉了也一樣）', () => {
    expect(onboardingPaymentChange(undefined, fromOnboarding)).toEqual({ mine: fromOnboarding, action: 'wait' });
    const closed = { ...fromOnboarding, checkoutTabId: null, closedAt: 1000 };
    expect(onboardingPaymentChange(fromOnboarding, closed)).toEqual({ mine: closed, action: 'wait' });
  });

  it('本來在等、SW 清掉了：去讀方案決定結果', () => {
    expect(onboardingPaymentChange(fromOnboarding, undefined)).toEqual({ mine: undefined, action: 'settled' });
  });

  it('打開 onboarding 時沒有付款：什麼都不做', () => {
    expect(onboardingPaymentChange(undefined, undefined)).toEqual({ mine: undefined, action: 'none' });
  });

  it('side panel 發起的付款不關 onboarding 的事；從 onboarding 換成 side panel 發起，等於 onboarding 這邊結束了', () => {
    expect(onboardingPaymentChange(undefined, fromPanel)).toEqual({ mine: undefined, action: 'none' });
    expect(onboardingPaymentChange(fromOnboarding, fromPanel)).toEqual({ mine: undefined, action: 'settled' });
  });
});
