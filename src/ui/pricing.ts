/**
 * Subscription 的價格文案（spec #254 的共用文字）：帳號頁、onboarding、side panel 都照這幾句，一字不差。
 * 數字全從 hosted-api.ts 的常數算出來，改價只改常數。
 */
import { MONTHLY_PAGES, PERIOD_MONTHS, PRICE_USD, REFUND_WINDOW_DAYS, type BillingPeriod } from '../shared/hosted-api.ts';

/** 一種 Billing Period 的價格：畫面上是「<strong>{name} {price}</strong>・{detail}」。 */
export interface BillingPeriodOffer {
  billingPeriod: BillingPeriod;
  name: string;
  price: string;
  detail: string;
  /** 標「推薦」（年繳）。 */
  recommended: boolean;
  /** 選這一種的按鈕。 */
  subscribe: string;
}

const NAME: Record<BillingPeriod, string> = { quarterly: '季繳', yearly: '年繳' };

/** 美元金額：整數不帶小數，其他兩位小數。 */
const usd = (amount: number) => `US$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

const monthly = (period: BillingPeriod) => PRICE_USD[period] / PERIOD_MONTHS[period];

export function billingPeriodOffer(billingPeriod: BillingPeriod): BillingPeriodOffer {
  const name = NAME[billingPeriod];
  // 年繳比季繳每月便宜多少（以季繳的每月價格為準）
  const saving = Math.round((1 - monthly('yearly') / monthly('quarterly')) * 100);
  return {
    billingPeriod,
    name,
    price: usd(PRICE_USD[billingPeriod]),
    detail: billingPeriod === 'yearly' ? `平均每月 ${usd(monthly('yearly'))}・省 ${saving}%` : `每 ${PERIOD_MONTHS.quarterly} 個月扣款`,
    recommended: billingPeriod === 'yearly',
    subscribe: `訂閱${name}`,
  };
}

/** 並排的順序：年繳（推薦）在前。 */
export const SUBSCRIPTION_OFFERS: readonly BillingPeriodOffer[] = [billingPeriodOffer('yearly'), billingPeriodOffer('quarterly')];

/** 頁數加千分位（3,000）。 */
export const pages = (n: number) => n.toLocaleString('en-US');

/** 兩種 Billing Period 共通的一行。 */
export const subscriptionHeadline = () => `每月 ${pages(MONTHLY_PAGES)} 頁・${REFUND_WINDOW_DAYS} 天內可全額退款`;
