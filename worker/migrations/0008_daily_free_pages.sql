-- Daily Free Pages Cap（#241）：全站每天（UTC，day 是 YYYY-MM-DD）扣掉的 Free Pages 頁數。到了 DAILY_FREE_PAGES_CAP，
-- 只靠 Free Pages 的 Account 當天剩下的時間不再送 Anthropic。沒有 Account id：只是一個全站的計數。
CREATE TABLE daily_free_pages (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL
);
