-- 用量紀錄的觀察欄位（#341）：只有數字、旗標與外掛產生的隨機作品 ID，不含內容（PRIVACY.md、ADR 0015）。這之前的紀錄都是 NULL。
-- - series_id：請求最上層的 seriesId（外掛產生的隨機 UUID）。只有新版外掛會送，不從 Notes 條目拿（讀者可能只同意過舊版）；刪帳號時設成 NULL
-- - notes_entries：這部作品目前 Series Notes 有幾條（外掛送上來，① 與 ② 填同一個數字）
-- - notes_sent_entries：這次呼叫實際送了幾條完整條目（Worker 數）
-- - suspect_lines：① 有幾句 Suspect Line 再問了一次（Worker 數）
-- - retranslation：① 與 ② 是不是讀者要求的 Retranslation（外掛送上來的旗標，1／0）
-- lines（0014）從這版起每次 ① 都填這次翻了幾句，不只 Strip。
ALTER TABLE usage_records ADD COLUMN series_id TEXT;
ALTER TABLE usage_records ADD COLUMN notes_entries INTEGER;
ALTER TABLE usage_records ADD COLUMN notes_sent_entries INTEGER;
ALTER TABLE usage_records ADD COLUMN suspect_lines INTEGER;
ALTER TABLE usage_records ADD COLUMN retranslation INTEGER;
