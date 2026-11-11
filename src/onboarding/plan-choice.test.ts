import { describe, expect, it } from 'vitest';
import { planChoiceView, PLAN_CHOICES } from './plan-choice.ts';

describe('onboarding 第 3 步的方案選擇（設計稿 C 版：單選清單＋一顆按鈕）', () => {
  it('由上到下：免費（預設）、年繳（推薦）、季繳', () => {
    expect(PLAN_CHOICES).toEqual([
      { choice: 'free', title: '先用免費額度 100 頁', detail: '', recommended: false, note: '大約四話，不會過期，不用輸入付款資料。' },
      { choice: 'yearly', title: '年繳・每年扣款 US$48', detail: '・平均每月 US$4・省 20%', recommended: true, note: '每月 3,000 頁・14 天內可全額退款' },
      { choice: 'quarterly', title: '季繳・每 3 個月扣款 US$15', detail: '・平均每月 US$5', recommended: false, note: '每月 3,000 頁・14 天內可全額退款' },
    ]);
  });

  it('選免費：「免費開始（100 頁）」，不前往付款', () => {
    expect(planChoiceView('free')).toEqual({ button: '免費開始（100 頁）', note: '用完再決定要不要訂閱。', billingPeriod: undefined });
  });

  it('選年繳：「訂閱年繳，前往付款」，結帳用年繳', () => {
    expect(planChoiceView('yearly')).toEqual({
      button: '訂閱年繳，前往付款',
      note: '付款頁會在新分頁打開（由 Paddle 處理付款）。',
      billingPeriod: 'yearly',
    });
  });

  it('選季繳：「訂閱季繳，前往付款」，結帳用季繳', () => {
    expect(planChoiceView('quarterly')).toEqual({
      button: '訂閱季繳，前往付款',
      note: '付款頁會在新分頁打開（由 Paddle 處理付款）。',
      billingPeriod: 'quarterly',
    });
  });
});
