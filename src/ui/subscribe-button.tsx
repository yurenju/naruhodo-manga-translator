import { MONTHLY_AVERAGE_USD, MONTHLY_PAGES, YEARLY_PRICE_USD } from '../shared/hosted-api.ts';
import { Button, Callout, PricePair } from './components.tsx';

/** 訂閱的雙價並列（onboarding 的方案卡、side panel 的免費額度用完）：你付 US$20／年 → 平均 US$1.67／月。 */
export function SubscriptionPrice() {
  return (
    <PricePair
      pay={{ label: '你付', price: `US$${YEARLY_PRICE_USD}`, unit: '／年', note: '一年扣款一次' }}
      average={{ label: '平均', price: `US$${MONTHLY_AVERAGE_USD}`, unit: '／月', note: `每月 ${MONTHLY_PAGES} 頁` }}
    />
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
