import { describe, expect, it } from 'vitest';
import { billingPeriodOffer, subscriptionHeadline, SUBSCRIPTION_OFFERS } from './pricing.ts';

describe('Subscription 的價格文案（spec #254 的共用文字，一字不差）', () => {
  it('年繳：每年扣款 US$48、平均每月 US$4・省 20%、推薦', () => {
    expect(billingPeriodOffer('yearly')).toEqual({
      billingPeriod: 'yearly',
      name: '年繳',
      charge: '每年扣款 US$48',
      average: 'US$4',
      saving: '省 20%',
      detail: '平均每月 US$4・省 20%',
      price: 'US$48',
      brief: '平均每月 US$4・省 20%',
      recommended: true,
      subscribe: '訂閱年繳',
    });
  });

  it('季繳：每 3 個月扣款 US$15、平均每月 US$5', () => {
    expect(billingPeriodOffer('quarterly')).toEqual({
      billingPeriod: 'quarterly',
      name: '季繳',
      charge: '每 3 個月扣款 US$15',
      average: 'US$5',
      saving: undefined,
      detail: '平均每月 US$5',
      price: 'US$15',
      brief: '每 3 個月扣款',
      recommended: false,
      subscribe: '訂閱季繳',
    });
  });

  it('並排的順序：年繳在前（推薦），季繳在後', () => {
    expect(SUBSCRIPTION_OFFERS.map((o) => o.billingPeriod)).toEqual(['yearly', 'quarterly']);
  });

  it('兩種共通的一行：每月頁數與退款期', () => {
    expect(subscriptionHeadline()).toBe('每月 3,000 頁・14 天內可全額退款');
  });
});
