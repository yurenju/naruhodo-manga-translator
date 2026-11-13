-- Strip（條漫，#282）照句數計頁：每翻譯 8 句 Line 計一個 Translated Page，累計記在同一串第一筆翻譯紀錄底下。
-- strip：這筆翻譯是 Strip 的請求（1）；lines：這次翻了幾句（只有句數，不存內容）。同一串之後的翻譯紀錄用
-- page_record_id 指到第一筆，累計＝第一筆與指到它的紀錄的 lines 加總。這之前的紀錄 strip 是 0、lines 是 NULL。
ALTER TABLE usage_records ADD COLUMN strip INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN lines INTEGER;
