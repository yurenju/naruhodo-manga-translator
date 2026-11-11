import { Badge, Callout } from './components.tsx';
import type { BillingPeriodOffer } from './pricing.ts';

/** 句子裡的一種 Billing Period：「<strong>年繳・每年扣款 US$48</strong>・平均每月 US$4・省 20%」。 */
export function OfferText({ offer }: { offer: BillingPeriodOffer }) {
  return (
    <>
      <strong>
        {offer.name}・{offer.charge}
      </strong>
      ・{offer.detail}
    </>
  );
}

/**
 * 卡片上的價格（跟網站價格卡片同一種呈現）：方案名、實際扣款（粗體＋省多少）、「平均 US$4 / 月」大字。
 * 月費大字方便比較，實際扣款緊貼在上面，不會讓人以為是月繳。
 */
export function OfferPrice({ offer }: { offer: BillingPeriodOffer }) {
  return (
    <div class="naru-offer-price">
      <p class="naru-offer-price__name">{offer.name}</p>
      <p class="naru-offer-price__charge">
        {offer.charge}
        {offer.saving && <Badge>{offer.saving}</Badge>}
      </p>
      <p class="naru-offer-price__average">
        <small>平均</small>
        <strong>{offer.average}</strong>/ 月
      </p>
    </div>
  );
}

/** 年繳、季繳兩行價格（side panel 的免費額度用完）：空間小、只是引導去看方案，用短寫法。 */
export function SubscriptionPrice({ offers }: { offers: readonly BillingPeriodOffer[] }) {
  return (
    <ul class="naru-offer-lines">
      {offers.map((offer) => (
        <li key={offer.billingPeriod}>
          <strong>
            {offer.name} {offer.price}
          </strong>
          ・{offer.brief}
        </li>
      ))}
    </ul>
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
