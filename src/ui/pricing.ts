/**
 * Subscription 的價格文案（spec #254 的共用文字）：帳號頁、onboarding、side panel 都照這幾句，一字不差。
 * 數字全從 hosted-api.ts 的常數算出來，改價只改常數。
 */
import { MONTHLY_PAGES, pageCount, PERIOD_MONTHS, PRICE_USD, REFUND_WINDOW_DAYS, type BillingPeriod } from '../shared/hosted-api.ts';

/**
 * 一種 Billing Period 的價格。先講實際扣款、再講平均月費（設計稿「購買流程」第 6 區 A4）：
 * 句子裡是「<strong>{name}・{charge}</strong>・{detail}」（OfferText），卡片上是扣款一行、平均月費大字（OfferPrice）。
 */
export interface BillingPeriodOffer {
  billingPeriod: BillingPeriod;
  name: string;
  /** 實際扣款：「每年扣款 US$48」 */
  charge: string;
  /** 平均月費：「US$4」 */
  average: string;
  /** 比季繳省多少（只有年繳）：「省 20%」 */
  saving: string | undefined;
  /** 句子裡接在扣款後面：「平均每月 US$4・省 20%」 */
  detail: string;
  /**
   * side panel 的短寫法（設計稿 SidePanel-Exhausted，空間小、只是引導去看方案）：「<strong>{name} {price}</strong>・{brief}」，
   * 例如「年繳 US$48・平均每月 US$4・省 20%」「季繳 US$15・每 3 個月扣款」。
   */
  price: string;
  brief: string;
  /** 標「推薦」（年繳）。 */
  recommended: boolean;
  /** 選這一種的按鈕。 */
  subscribe: string;
}

const NAME: Record<BillingPeriod, string> = { quarterly: '季繳', yearly: '年繳' };

/** 美元金額：整數不帶小數，其他兩位小數。 */
export const usd = (amount: number) => `US$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

/** 平均每月多少美元。 */
export const monthlyPriceUsd = (period: BillingPeriod) => PRICE_USD[period] / PERIOD_MONTHS[period];

/** 年繳比季繳每月便宜幾 %（以季繳的每月價格為準）。 */
export const yearlySavingPercent = () => Math.round((1 - monthlyPriceUsd('yearly') / monthlyPriceUsd('quarterly')) * 100);

const CHARGE: Record<BillingPeriod, () => string> = {
  quarterly: () => `每 ${PERIOD_MONTHS.quarterly} 個月扣款 ${usd(PRICE_USD.quarterly)}`,
  yearly: () => `每年扣款 ${usd(PRICE_USD.yearly)}`,
};

/** 推薦的 Billing Period（標「推薦」、排在前面）。 */
const RECOMMENDED: BillingPeriod = 'yearly';

export function billingPeriodOffer(billingPeriod: BillingPeriod): BillingPeriodOffer {
  const name = NAME[billingPeriod];
  const average = usd(monthlyPriceUsd(billingPeriod));
  const saving = billingPeriod === 'yearly' ? `省 ${yearlySavingPercent()}%` : undefined;
  return {
    billingPeriod,
    name,
    charge: CHARGE[billingPeriod](),
    average,
    saving,
    detail: [`平均每月 ${average}`, saving].filter(Boolean).join('・'),
    price: usd(PRICE_USD[billingPeriod]),
    brief: billingPeriod === 'yearly' ? [`平均每月 ${average}`, saving].filter(Boolean).join('・') : `每 ${PERIOD_MONTHS[billingPeriod]} 個月扣款`,
    recommended: billingPeriod === RECOMMENDED,
    subscribe: `訂閱${name}`,
  };
}

/** 並排的順序：年繳（推薦）在前。 */
export const SUBSCRIPTION_OFFERS: readonly BillingPeriodOffer[] = [billingPeriodOffer('yearly'), billingPeriodOffer('quarterly')];

/** Free Pages 大約是幾話（FREE_PAGES 100 頁，一話大約 25 頁）：onboarding 與網站的免費方案都用這句，改 FREE_PAGES 時一起改。 */
export const FREE_PAGES_EPISODES = '大約四話';

/** 兩種 Billing Period 共通的一行。 */
export const subscriptionHeadline = () => `每月 ${pageCount(MONTHLY_PAGES)} 頁・${REFUND_WINDOW_DAYS} 天內可全額退款`;
