/**
 * onboarding 第 3 步的方案選擇（spec #254，設計稿「購買流程」C 版）：單選清單，由上到下免費（預設）、年繳（推薦）、季繳，
 * 下面一顆主按鈕，文字跟著選項變。價格文字來自 ui/pricing.ts 的共用文案。
 */
import { FREE_PAGES, type BillingPeriod } from '../shared/hosted-api.ts';
import { billingPeriodOffer, FREE_PAGES_EPISODES, subscriptionHeadline } from '../ui/pricing.ts';

/** 讀者在清單上選的那一項。 */
export type PlanChoice = 'free' | BillingPeriod;

/** 清單上的一項：「<strong>{title}</strong>{detail}［推薦］」，下一行小字是 note。 */
export interface PlanChoiceOption {
  choice: PlanChoice;
  title: string;
  detail: string;
  recommended: boolean;
  note: string;
}

const offerOption = (billingPeriod: BillingPeriod): PlanChoiceOption => {
  const offer = billingPeriodOffer(billingPeriod);
  return { choice: billingPeriod, title: `${offer.name}・${offer.charge}`, detail: `・${offer.detail}`, recommended: offer.recommended, note: subscriptionHeadline() };
};

export const PLAN_CHOICES: readonly PlanChoiceOption[] = [
  { choice: 'free', title: `先用免費額度 ${FREE_PAGES} 頁`, detail: '', recommended: false, note: `${FREE_PAGES_EPISODES}，不會過期，不用輸入付款資料。` },
  offerOption('yearly'),
  offerOption('quarterly'),
];

/** 一進來選的是免費：不用還沒用過就先付錢。 */
export const DEFAULT_PLAN_CHOICE: PlanChoice = 'free';

/** 主按鈕與它下面的說明；billingPeriod＝按下去要結帳的扣款週期，undefined＝先用免費額度。 */
export interface PlanChoiceView {
  button: string;
  note: string;
  billingPeriod: BillingPeriod | undefined;
}

export function planChoiceView(choice: PlanChoice): PlanChoiceView {
  if (choice === 'free') return { button: `免費開始（${FREE_PAGES} 頁）`, note: '用完再決定要不要訂閱。', billingPeriod: undefined };
  return { button: `${billingPeriodOffer(choice).subscribe}，前往付款`, note: '付款頁會在新分頁打開（由 Paddle 處理付款）。', billingPeriod: choice };
}
