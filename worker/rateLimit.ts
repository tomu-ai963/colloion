/**
 * D1 ベースの固定窓レート制限（bitane の src/middleware/rate-limit.ts と同じ方式）。
 * (key, window_start) の行を upsert してカウントし、上限を超えたら RateLimited を投げる。
 */

import type { D1Like } from './db'

export class RateLimited extends Error {
  constructor(readonly retryAfterSec: number) {
    super('リクエストが多すぎます。しばらく待ってから試してください')
    this.name = 'RateLimited'
  }
}

export async function enforceRateLimit(
  db: D1Like,
  name: string,
  key: string,
  limit: number,
  windowSec = 3600,
  nowMs = Date.now(),
): Promise<void> {
  const windowStart = Math.floor(nowMs / 1000 / windowSec) * windowSec
  const { results } = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(`${name}:${key}`, windowStart)
    .all<{ count: number }>()
  if ((results[0]?.count ?? 0) > limit) {
    throw new RateLimited(windowStart + windowSec - Math.floor(nowMs / 1000))
  }
}
