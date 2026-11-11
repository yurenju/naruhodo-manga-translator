import { describe, expect, it } from 'vitest';
import { billingPeriodOffer, subscriptionHeadline, SUBSCRIPTION_OFFERS } from './pricing.ts';

describe('Subscription 的價格文案（spec #254 的共用文字，一字不差）', () => {
  it('年繳：US$48、平均每月 US$4・省 20%、推薦', () => {
    expect(billingPeriodOffer('yearly')).toEqual({
      billingPeriod: 'yearly',
      name: '年繳',
      price: 'US$48',
      detail: '平均每月 US$4・省 20%',
      recommended: true,
      subscribe: '訂閱年繳',
    });
  });

  it('季繳：US$15、每 3 個月扣款', () => {
    expect(billingPeriodOffer('quarterly')).toEqual({
      billingPeriod: 'quarterly',
      name: '季繳',
      price: 'US$15',
      detail: '每 3 個月扣款',
      recommended: false,
      subscribe: '訂閱季繳',
    });
  });

  it('並排的順序：年繳在前（推薦），季繳在後', () => {
    expect(SUBSCRIPTION_OFFERS.map((o) => o.billingPeriod)).toEqual(['yearly', 'quarterly']);
  });

  it('兩種共通的一行：每月頁數與退款期', () => {
    expect(subscriptionHeadline()).toBe('每月 800 頁・14 天內可全額退款');
  });
});
