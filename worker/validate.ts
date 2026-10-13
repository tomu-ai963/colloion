/**
 * リクエストの検査。サーバーはレコードの中身を解釈しないが、
 * 版の管理に使う項目（kind / id / baseRev / updatedAt / deletedAt）と大きさは確かめる。
 * レコードは本人にしか返らないので、中身の詳細な形までは検査しない。
 */

import {
  ID_PATTERN,
  MAX_RECORD_BYTES,
  PUSH_BATCH_LIMIT,
  SYNC_KINDS,
  type PushChange,
} from '../src/sync/protocol'

export class BadRequest extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message)
    this.name = 'BadRequest'
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isRev = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength

export function parsePushBody(text: string): PushChange[] {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new BadRequest('JSON として読めません')
  }
  if (!isObject(body) || !Array.isArray(body.changes)) throw new BadRequest('changes がありません')
  const changes = body.changes
  if (changes.length > PUSH_BATCH_LIMIT) {
    throw new BadRequest(`1 回に送れるのは ${PUSH_BATCH_LIMIT} 件までです`)
  }

  const seen = new Set<string>()
  return changes.map((c, i): PushChange => {
    const at = `changes[${i}]`
    if (!isObject(c)) throw new BadRequest(`${at} がオブジェクトではありません`)
    const { kind, id, baseRev, record } = c
    if (!SYNC_KINDS.includes(kind as never)) throw new BadRequest(`${at}.kind が不正です`)
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new BadRequest(`${at}.id が不正です`)
    if (baseRev !== null && !isRev(baseRev)) throw new BadRequest(`${at}.baseRev が不正です`)
    if (!isObject(record)) throw new BadRequest(`${at}.record がオブジェクトではありません`)
    if (record.id !== id) throw new BadRequest(`${at}.record.id が id と一致しません`)
    if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) {
      throw new BadRequest(`${at}.record.updatedAt が不正です`)
    }
    if (record.deletedAt !== undefined && !Number.isFinite(record.deletedAt)) {
      throw new BadRequest(`${at}.record.deletedAt が不正です`)
    }
    if (utf8Bytes(JSON.stringify(record)) > MAX_RECORD_BYTES) {
      throw new BadRequest(`${at}.record が大きすぎます`, 413)
    }
    // 同じレコードを 1 回の push に 2 度入れると、2 件目が 1 件目に対して必ず競合する
    const key = `${kind as string}:${id}`
    if (seen.has(key)) throw new BadRequest(`${at} が重複しています`)
    seen.add(key)
    return c as unknown as PushChange
  })
}

/** pull の since。省略時は 0（最初から） */
export function parseSince(raw: string | null): number {
  if (raw === null || raw === '') return 0
  if (!/^\d{1,15}$/.test(raw)) throw new BadRequest('since が不正です')
  return Number(raw)
}
