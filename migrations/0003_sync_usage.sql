-- ユーザーごとの容量上限（レコード数・バイト数）のための使用量。
-- push のたびに records を SUM すると、ユーザーの全行を読む（D1 の rows read が件数に比例して増える）ので、
-- トリガーで常に最新の合計を持っておき、Worker は 1 行だけ読んで判定する（worker/sync.ts）。
-- 墓標（deleted = 1）も行と本文が残るので数える。削除しても使用量は減らない。
-- bytes は本文の UTF-8 のバイト数（length(text) は文字数なので BLOB にして測る）。
CREATE TABLE sync_usage (
  user_id TEXT    NOT NULL PRIMARY KEY,
  records INTEGER NOT NULL DEFAULT 0,
  bytes   INTEGER NOT NULL DEFAULT 0
);

-- 既存のレコードから作る（0003 の適用時点の値）
INSERT INTO sync_usage (user_id, records, bytes)
SELECT user_id, COUNT(*), SUM(length(CAST(body AS BLOB))) FROM records GROUP BY user_id;

CREATE TRIGGER records_usage_insert AFTER INSERT ON records
BEGIN
  INSERT OR IGNORE INTO sync_usage (user_id) VALUES (NEW.user_id);
  UPDATE sync_usage
     SET records = records + 1,
         bytes = bytes + length(CAST(NEW.body AS BLOB))
   WHERE user_id = NEW.user_id;
END;

-- push の UPSERT（ON CONFLICT DO UPDATE）はこちらが動く
CREATE TRIGGER records_usage_update AFTER UPDATE OF body ON records
BEGIN
  UPDATE sync_usage
     SET bytes = bytes - length(CAST(OLD.body AS BLOB)) + length(CAST(NEW.body AS BLOB))
   WHERE user_id = NEW.user_id;
END;

-- アプリからは物理削除しないが、手作業で行を消したときに合計がずれないように
CREATE TRIGGER records_usage_delete AFTER DELETE ON records
BEGIN
  UPDATE sync_usage
     SET records = records - 1,
         bytes = bytes - length(CAST(OLD.body AS BLOB))
   WHERE user_id = OLD.user_id;
END;
