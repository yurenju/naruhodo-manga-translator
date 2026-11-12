-- 退款過的 email（SHA-256 hash，ADR 0012）：Paddle 核准過一次全額退款就記下，刪除帳號後仍保留。
-- 同一個 email 之後的退款不能在外掛裡申請，要寫信（REFUND.md：同一個人反覆退款可能被拒）。時間是 Unix 毫秒。
CREATE TABLE refunded_emails (
  email_hash TEXT PRIMARY KEY,
  refunded_at INTEGER NOT NULL
);
