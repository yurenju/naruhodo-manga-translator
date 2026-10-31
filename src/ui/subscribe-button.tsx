import { Button, Callout } from './components.tsx';

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
