-- 成功的扣款（#260）：Paddle 的 transaction.completed webhook 寫入，算 Refund Window（扣款後 14 天）與建立退款要用。時間是 Unix 毫秒。
-- amount_cents 是實付金額（Paddle 的 details.totals.grand_total，美分，折扣後、含稅）。
-- refund_status：NULL＝沒申請過、'pending'＝已向 Paddle 建立退款（refund_adjustment_id）、等核准，'approved'／'rejected'＝Paddle 的結果。
CREATE TABLE charges (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  paddle_subscription_id TEXT NOT NULL,
  billed_at INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  refund_status TEXT CHECK (refund_status IN ('pending', 'approved', 'rejected')),
  refund_adjustment_id TEXT
);

CREATE INDEX charges_account ON charges(account_id, billed_at);
