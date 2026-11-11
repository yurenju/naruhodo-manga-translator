import { Button, Callout } from './components.tsx';
import { SUBSCRIPTION_OFFERS, type BillingPeriodOffer } from './pricing.ts';

/** 一種 Billing Period 的共用文字：「<strong>年繳 US$48</strong>・平均每月 US$4・省 20%」。 */
export function OfferText({ offer }: { offer: BillingPeriodOffer }) {
  return (
    <>
      <strong>
        {offer.name} {offer.price}
      </strong>
      ・{offer.detail}
    </>
  );
}

/** 年繳、季繳兩行價格（onboarding 的方案卡、side panel 的免費額度用完）。 */
export function SubscriptionPrice() {
  return (
    <ul class="naru-offer-lines">
      {SUBSCRIPTION_OFFERS.map((offer) => (
        <li key={offer.billingPeriod}>
          <OfferText offer={offer} />
        </li>
      ))}
    </ul>
  );
}

/** 「訂閱」按鈕（side panel、設定頁、onboarding 共用）。沒給 onSubscribe（網站上的展示、還在讀方案）時停用。 */
export function SubscribeButton({ variant, onSubscribe }: { variant: 'primary' | 'link'; onSubscribe: (() => void) | undefined }) {
  return (
    <Button variant={variant} disabled={!onSubscribe} onClick={onSubscribe}>
      訂閱
    </Button>
  );
}

/** 「訂閱」「管理訂閱」向 Worker 要網址失敗（連不上、Paddle 拒絕）：沒有打開新分頁，要讓讀者知道按了有反應（#156）。 */
export function PaymentUnavailable() {
  return (
    <Callout tone="danger" role="alert">
      <p>付款服務暫時無法使用，請稍後再試。</p>
    </Callout>
  );
}
