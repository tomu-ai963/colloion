-- Phase 3: 端末間同期のレコード置き場。
-- 本体（body）は JSON をそのまま持つ。サーバーは中身を解釈せず、版の管理だけを行う。
-- rev はユーザーごとの通し番号で、レコードの版であると同時に pull の位置（cursor）になる。
-- 物理削除はしない（削除は墓標 deleted = 1 として残す）ので、ユーザーの MAX(rev) は下がらない。
CREATE TABLE records (
  user_id    TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('batch', 'reagent', 'stock', 'pipette', 'session')),
  id         TEXT    NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  body       TEXT    NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);

-- pull（rev > since の順読み）と、push の採番（ユーザーの MAX(rev)）に使う
CREATE UNIQUE INDEX records_user_rev ON records (user_id, rev);
