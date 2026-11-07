-- 用量紀錄涵蓋所有計費的 Anthropic 呼叫（#238），讓 D1 的總額能跟 Anthropic Console 的帳單對帳（#17）：
-- - kind 多一種 'series_guess'（猜作品原名，#186）
-- - cache_write_tokens：input_tokens 仍是一般 input＋cache write＋cache read 的總和，cache write 另外記，對不上時分得出是哪一種價格；
--   model：這次呼叫的模型。這兩欄在這之前的紀錄是 NULL
-- - account_id 可以是 NULL：刪除帳號時用量紀錄不刪，只拿掉帳號關聯（匿名保留）
-- SQLite 改不了 CHECK 與 NOT NULL，所以整張表重建；id、page_record_id 與其他欄位原樣複製。
-- 這是 CODING_STANDARDS.md「A D1 migration only adds」的例外：沒有欄位改名或刪除，只是放寬限制，
-- 舊程式碼（部署前幾秒、或 wrangler rollback 之後）的 INSERT 不帶新欄位（都可以是 NULL）、刪帳號的 DELETE 也照樣跑得動。
-- 不複製 sqlite_sequence：新表的序號從現有最大的 id 接著算。以前刪帳號刪掉的最大幾個 id 可能被重新用到，
-- 但那些 id 只回給過已刪除的 Account（token 都失效了），沒有人能再帶它來接續或歸屬 Notes。
CREATE TABLE usage_records_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('translate', 'notes', 'series_guess')),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER,
  cost_usd REAL NOT NULL,
  model TEXT,
  page_record_id INTEGER,
  practice INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_records_new (id, account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd, page_record_id, practice)
  SELECT id, account_id, created_at, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd, page_record_id, practice FROM usage_records;

DROP TABLE usage_records;

ALTER TABLE usage_records_new RENAME TO usage_records;

CREATE INDEX usage_records_account ON usage_records(account_id, created_at);
