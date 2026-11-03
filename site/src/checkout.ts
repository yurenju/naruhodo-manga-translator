/**
 * checkout 頁的規則（#89）。頁面由 #94 的 Worker 組出 `/<語系>/checkout?_ptxn=<transaction id>`，
 * 載入 Paddle.js 後由它依 `_ptxn` 打開 overlay；這裡只放能脫離 DOM 測的部分。
 */
import { type Locale, languageTag } from './locale.ts';

/** Paddle checkout 的 `settings.locale`：付款畫面的語言跟網站相同。Paddle 收的正好是同樣的語言標籤。 */
export function paddleLocale(locale: Locale): string {
  return languageTag(locale);
}

/**
 * 頁面背景顯示什麼：loading 是 Paddle.js 還在載入或 overlay 還沒出現；
 * failed 是 Paddle.js 載入失敗或 Paddle 回報錯誤（顯示錯誤與重試）；missing 是網址沒有 transaction。
 */
export type CheckoutState = 'loading' | 'open' | 'closed' | 'completed' | 'failed' | 'missing';

/** 收到 Paddle.js 的事件（`eventCallback` 的 `name`）後的狀態。 */
export function checkoutStateAfter(state: CheckoutState, eventName: string): CheckoutState {
  // 付款完成後 overlay 先顯示 Paddle 的成功畫面，讀者關掉時還會再送 checkout.closed
  if (state === 'completed') return state;
  switch (eventName) {
    case 'checkout.loaded': return 'open';
    case 'checkout.closed': return 'closed';
    case 'checkout.completed': return 'completed';
    case 'checkout.error': return 'failed';
    default: return state;
  }
}

/** 付款完成後等這麼久外掛還沒把分頁關掉（webhook 通常幾秒內就到），就提示讀者可以自己關。 */
export const SLOW_RETURN_MS = 20_000;

/** 網址的 `_ptxn`；不是 Paddle transaction id（`txn_` 開頭）就是 null。 */
export function transactionIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get('_ptxn');
  return id?.startsWith('txn_') ? id : null;
}
