-- 下次續訂金額（spec #254）：訂閱的 item 的 Paddle price 的 unit_price × quantity（美分；price 含稅，ADR 0012），由 subscription.* webhook 寫入。
-- Paddle 上換了價格，下一個事件就會帶新金額，不用改程式碼。這個欄位之前寫入的訂閱是 NULL，GET /v1/account 退回定價常數（PRICE_USD）。
ALTER TABLE subscriptions ADD COLUMN renewal_price_cents INTEGER;
