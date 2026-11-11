-- Free Pages 從 50 頁提高到 100 頁（#256、ADR 0012）：現有的每個 Account 剩下的 Free Pages 都多 50 頁，
-- 跟新 Account 拿到一樣多。包括已經用完（剩 0）與訂閱中的 Account（訂閱結束或退款後就用得到）。
UPDATE quotas SET free_pages = free_pages + 50;
