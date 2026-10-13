-- Phase 3 Step 4: 認証の中継（/api/auth/*）に掛ける簡易レート制限のカウンタ（bitane と同じ方式）。
-- key = '<名前>:<識別子>'（例 'otp_email:foo@example.com'）
-- window_start = 時間窓の先頭（unix epoch 秒）。窓が変われば行が変わる（固定窓）
CREATE TABLE rate_limits (
  key          TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
-- 古い窓の掃除用
CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);
