/**
 * 同期 API の本体（push / pull）。規則は src/sync/memoryServer.ts（基準実装）と同じ。
 *
 * push の採番と競合判定は SQL の中で行う（1 文 = 1 件）。
 *   - 新しい rev = そのユーザーの MAX(rev) + 1
 *   - サーバー上の rev が baseRev と一致するとき（レコードが無ければ常に）だけ書く
 * D1 は batch を 1 トランザクションで直列に実行するので、同じユーザーの push が
 * 並行しても採番が重複したり、確認と書き込みの間に割り込まれたりしない。
 * 書けたかどうかは RETURNING の行の有無で分かる。
 *
 * 容量上限（MAX_USER_RECORDS / MAX_USER_BYTES）は書く前に確かめる。使用量は sync_usage
 * （migrations/0004 のトリガーが保つ合計）から読み、この push で増える分を足して判定する。
 * 件数は墓標を除いた数、バイト数は墓標を含む本文の合計。墓標は本文を持たない形で保存するので
 * （toTombstone）、削除すると件数もバイト数も空く。
 * 確認と書き込みは別の呼び出しなので、同じユーザーの push が並行すると 1 回分（最大
 * PUSH_BATCH_LIMIT 件・MAX_PUSH_BYTES）まで上限を超えうる。DB の容量を守る目的には足りる。
 */

import { toTombstone, type SyncKind } from '../src/core/merge'
import {
  MAX_USER_BYTES,
  MAX_USER_RECORDS,
  type AnyRecord,
  type PullChange,
  type PullResponse,
  type PushChange,
  type PushResponse,
  type PushResult,
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

/**
 * 保存する本文。rev はサーバーの列が正なので本文からは外す。
 * 墓標はクライアントが本文を付けて送ってきても（古い版のアプリ）落として保存する
 */
function bodyOf(record: AnyRecord): string {
  const r = record.deletedAt !== undefined ? toTombstone(record) : record
  return JSON.stringify({ ...r, rev: undefined }) // undefined のキーは JSON に出ない
}

const toRecord = (row: RecordRow): AnyRecord => ({ ...JSON.parse(row.body), rev: row.rev }) as AnyRecord

/** sync_usage と同じ測り方（本文の UTF-8 のバイト数） */
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength

export interface Quota {
  records: number
  bytes: number
}

export const DEFAULT_QUOTA: Quota = { records: MAX_USER_RECORDS, bytes: MAX_USER_BYTES }

/** 容量上限を超える push。usage は push 前の使用量 */
export class QuotaExceeded extends Error {
  constructor(
    readonly usage: Quota,
    readonly limit: Quota,
  ) {
    super('quota exceeded')
    this.name = 'QuotaExceeded'
  }
}

/**
 * この push で使用量がどれだけ増えるかを測り、上限を超えるなら QuotaExceeded を投げる。
 * 競合して書かれないものも書かれる前提で数える（多めに見積もる側に倒す）。
 * 増えない側（件数が増えない・バイト数が減る）の項目は上限を超えていても止めない
 * （上限に達したあとも、削除や編集で小さくすることはできる）。
 */
async function checkQuota(
  db: D1Like,
  userId: string,
  changes: PushChange[],
  bodies: string[],
  quota: Quota,
): Promise<void> {
  const [usageRows, existing] = await Promise.all([
    db
      .prepare('SELECT records, bytes FROM sync_usage WHERE user_id = ?1')
      .bind(userId)
      .all<Quota>(),
    fetchSizes(db, userId, changes),
  ])
  const usage = usageRows.results[0] ?? { records: 0, bytes: 0 }
  let addRecords = 0
  let addBytes = 0
  changes.forEach((c, i) => {
    const before = existing.get(`${c.kind}:${c.id}`)
    const liveAfter = c.record.deletedAt === undefined ? 1 : 0
    const liveBefore = before !== undefined && before.deleted === 0 ? 1 : 0
    addRecords += liveAfter - liveBefore
    addBytes += utf8Bytes(bodies[i]!) - (before?.bytes ?? 0)
  })
  if (
    (addRecords > 0 && usage.records + addRecords > quota.records) ||
    (addBytes > 0 && usage.bytes + addBytes > quota.bytes)
  ) {
    throw new QuotaExceeded(usage, quota)
  }
}

export async function push(
  db: D1Like,
  userId: string,
  changes: PushChange[],
  quota: Quota = DEFAULT_QUOTA,
): Promise<PushResponse> {
  if (changes.length === 0) return { results: [] }

  const bodies = changes.map((c) => bodyOf(c.record))
  await checkQuota(db, userId, changes, bodies, quota)

  const statements = changes.map((c, i) =>
    db
      .prepare(UPSERT_SQL)
      .bind(
        userId,
        c.kind,
        c.id,
        c.baseRev,
        Math.trunc(c.record.updatedAt),
        c.record.deletedAt !== undefined ? 1 : 0,
        bodies[i],
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

type Key = { kind: SyncKind; id: string }

/**
 * (kind, id) の組で絞る文を作る（D1 の 1 文あたりのパラメータ上限 100 に収まる件数で呼ぶ）。
 * columns は SELECT する列
 */
function selectByKeys(db: D1Like, userId: string, keys: Key[], columns: string) {
  const values = keys.map((_, i) => `(?${i * 2 + 2}, ?${i * 2 + 3})`).join(', ')
  return db
    .prepare(`SELECT ${columns} FROM records WHERE user_id = ?1 AND (kind, id) IN (VALUES ${values})`)
    .bind(userId, ...keys.flatMap((k) => [k.kind, k.id]))
}

/** (kind, id) の組をまとめて 1 文で読む */
async function fetchRecords(db: D1Like, userId: string, keys: Key[]): Promise<Map<string, RecordRow>> {
  const { results } = await selectByKeys(db, userId, keys, 'kind, id, rev, body').all<RecordRow>()
  return new Map(results.map((r) => [`${r.kind}:${r.id}`, r]))
}

interface StoredSize {
  bytes: number
  deleted: 0 | 1
}

/** サーバーにある版の本文のバイト数と墓標かどうか（無いものは入らない） */
async function fetchSizes(db: D1Like, userId: string, keys: Key[]): Promise<Map<string, StoredSize>> {
  const { results } = await selectByKeys(
    db,
    userId,
    keys,
    'kind, id, deleted, length(CAST(body AS BLOB)) AS bytes',
  ).all<Key & StoredSize>()
  return new Map(results.map((r) => [`${r.kind}:${r.id}`, { bytes: r.bytes, deleted: r.deleted }]))
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
