-- Practice Spread（#169）：Worker 認出試翻頁的文字時不扣頁，但照樣記一筆用量，標成試翻（1），算得出試翻的次數與成本。
ALTER TABLE usage_records ADD COLUMN practice INTEGER NOT NULL DEFAULT 0;
