-- 削除で容量が空くようにする。
-- 0003 までは墓標（deleted = 1）も本文ごと残り、件数にも数えていたので、削除しても使用量が減らなかった。
--   - 件数（records）は墓標を除いた数にする
--   - 墓標の本文を id・updatedAt・deletedAt だけにする（Worker も今後この形で保存する。toTombstone）
-- 墓標の行そのものは残す（他端末に削除を伝えるため）。バイト数には墓標の小さな本文が入る。
-- rev は変えない（本文を縮めても、クライアントが持つ墓標と意味は同じなので配り直さない）。

DROP TRIGGER records_usage_insert;
DROP TRIGGER records_usage_update;
DROP TRIGGER records_usage_delete;

UPDATE records
   SET body = json_object(
         'id', id,
         'updatedAt', json_extract(body, '$.updatedAt'),
         'deletedAt', json_extract(body, '$.deletedAt'))
 WHERE deleted = 1;

-- 使用量を数え直す
DELETE FROM sync_usage;
INSERT INTO sync_usage (user_id, records, bytes)
SELECT user_id, SUM(1 - deleted), SUM(length(CAST(body AS BLOB))) FROM records GROUP BY user_id;

CREATE TRIGGER records_usage_insert AFTER INSERT ON records
BEGIN
  INSERT OR IGNORE INTO sync_usage (user_id) VALUES (NEW.user_id);
  UPDATE sync_usage
     SET records = records + 1 - NEW.deleted,
         bytes = bytes + length(CAST(NEW.body AS BLOB))
   WHERE user_id = NEW.user_id;
END;

-- push の UPSERT（ON CONFLICT DO UPDATE）はこちらが動く。削除（deleted 0 → 1）で件数が減る
CREATE TRIGGER records_usage_update AFTER UPDATE OF body, deleted ON records
BEGIN
  UPDATE sync_usage
     SET records = records + OLD.deleted - NEW.deleted,
         bytes = bytes - length(CAST(OLD.body AS BLOB)) + length(CAST(NEW.body AS BLOB))
   WHERE user_id = NEW.user_id;
END;

-- アプリからは物理削除しないが、手作業で行を消したときに合計がずれないように
CREATE TRIGGER records_usage_delete AFTER DELETE ON records
BEGIN
  UPDATE sync_usage
     SET records = records - (1 - OLD.deleted),
         bytes = bytes - length(CAST(OLD.body AS BLOB))
   WHERE user_id = OLD.user_id;
END;
