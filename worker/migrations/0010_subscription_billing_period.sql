-- Billing Period（#259）：訂閱的 item 的 Paddle price 對應到哪一種扣款週期，由 subscription.* webhook 寫入。
-- 'quarterly' 或 'yearly'；改版前的訂閱（年繳 US$20）是 NULL，當年繳（ADR 0012：續約時改用新的年繳價格）。
ALTER TABLE subscriptions ADD COLUMN billing_period TEXT CHECK (billing_period IN ('quarterly', 'yearly'));
