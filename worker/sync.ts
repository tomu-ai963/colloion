/**
 * 同期 API の本体（push / pull）。規則は src/sync/memoryServer.ts（基準実装）と同じ。
 *
 * push の採番と競合判定は SQL の中で行う（1 文 = 1 件）。
 *   - 新しい rev = そのユーザーの MAX(rev) + 1
 *   - サーバー上の rev が baseRev と一致するとき（レコードが無ければ常に）だけ書く
 * D1 は batch を 1 トランザクションで直列に実行するので、同じユーザーの push が
 * 並行しても採番が重複したり、確認と書き込みの間に割り込まれたりしない。
 * 書けたかどうかは RETURNING の行の有無で分かる。
 */

import type { SyncKind } from '../src/core/merge'
import type {
  AnyRecord,
  PullChange,
  PullResponse,
  PushChange,
  PushResponse,
  PushResult,
} from '../src/sync/protocol'
import type { D1Like } from './db'

const UPSERT_SQL = `
INSERT INTO records (user_id, kind, id, rev, updated_at, deleted, body)
SELECT ?1, ?2, ?3, COALESCE((SELECT MAX(rev) FROM records WHERE user_id = ?1), 0) + 1, ?5, ?6, ?7
WHERE COALESCE((SELECT rev FROM records WHERE user_id = ?1 AND kind = ?2 AND id = ?3), ?4) IS ?4
ON CONFLICT (user_id, kind, id) DO UPDATE SET
  rev = excluded.rev,
  updated_at = excluded.updated_at,
  deleted = excluded.deleted,
  body = excluded.body
RETURNING rev`

interface RecordRow {
  kind: SyncKind
  id: string
  rev: number
  body: string
}

/** 保存する本文。rev はサーバーの列が正なので本文からは外す */
function bodyOf(record: AnyRecord): string {
  return JSON.stringify({ ...record, rev: undefined }) // undefined のキーは JSON に出ない
}

const toRecord = (row: RecordRow): AnyRecord => ({ ...JSON.parse(row.body), rev: row.rev }) as AnyRecord

export async function push(db: D1Like, userId: string, changes: PushChange[]): Promise<PushResponse> {
  if (changes.length === 0) return { results: [] }

  const statements = changes.map((c) =>
    db
      .prepare(UPSERT_SQL)
      .bind(
        userId,
        c.kind,
        c.id,
        c.baseRev,
        Math.trunc(c.record.updatedAt),
        c.record.deletedAt !== undefined ? 1 : 0,
        bodyOf(c.record),
      ),
  )
  const written = await db.batch<{ rev: number }>(statements)

  const results: (PushResult | null)[] = changes.map((c, i) => {
    const row = written[i]?.results[0]
    return row ? { kind: c.kind, id: c.id, status: 'ok', rev: row.rev } : null
  })

  // 競合したものはサーバー上の現在の版を返す（クライアントがマージする）
  const conflicted = changes.filter((_, i) => results[i] === null)
  if (conflicted.length > 0) {
    const current = await fetchRecords(db, userId, conflicted)
    changes.forEach((c, i) => {
      if (results[i] !== null) return
      const row = current.get(`${c.kind}:${c.id}`)
      // 競合 = サーバーに別の版がある、なので通常は必ず見つかる
      if (row) results[i] = { kind: c.kind, id: c.id, status: 'conflict', current: toRecord(row) }
    })
  }
  return { results: results.filter((r): r is PushResult => r !== null) }
}

/** (kind, id) の組をまとめて 1 文で読む（D1 の 1 文あたりのパラメータ上限 100 に収まる件数で呼ぶ） */
async function fetchRecords(
  db: D1Like,
  userId: string,
  keys: { kind: SyncKind; id: string }[],
): Promise<Map<string, RecordRow>> {
  const values = keys.map((_, i) => `(?${i * 2 + 2}, ?${i * 2 + 3})`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT kind, id, rev, body FROM records WHERE user_id = ?1 AND (kind, id) IN (VALUES ${values})`,
    )
    .bind(userId, ...keys.flatMap((k) => [k.kind, k.id]))
    .all<RecordRow>()
  return new Map(results.map((r) => [`${r.kind}:${r.id}`, r]))
}

export async function pull(
  db: D1Like,
  userId: string,
  since: number,
  limit: number,
): Promise<PullResponse> {
  const { results } = await db
    .prepare(
      'SELECT kind, id, rev, body FROM records WHERE user_id = ?1 AND rev > ?2 ORDER BY rev LIMIT ?3',
    )
    .bind(userId, since, limit + 1)
    .all<RecordRow>()
  const page = results.slice(0, limit)
  const changes: PullChange[] = page.map((r) => ({
    kind: r.kind,
    id: r.id,
    rev: r.rev,
    record: toRecord(r),
  }))
  return {
    changes,
    cursor: page.length > 0 ? page[page.length - 1]!.rev : since,
    hasMore: results.length > limit,
  }
}
