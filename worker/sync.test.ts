// @vitest-environment node
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Reagent, Stock } from '../src/core/model'
import { IndexedDbAdapter } from '../src/storage/indexedDbAdapter'
import { SyncEngine } from '../src/sync/engine'
import { HttpTransport } from '../src/sync/httpTransport'
import { MemorySyncServer } from '../src/sync/memoryServer'
import { PUSH_BATCH_LIMIT, type PushChange } from '../src/sync/protocol'
import { handle, type Env } from './index'
import { pull, push, QuotaExceeded, type Quota } from './sync'
import { createTestAuth, type TestAuth } from './testing/auth'
import { SqliteD1 } from './testing/sqliteD1'

const reagent = (id: string, patch: Partial<Reagent> = {}): Reagent => ({
  id,
  name: 'x',
  formula: 'NaCl',
  mw: 58.44,
  purityPct: 100,
  role: '電解質',
  updatedAt: 1,
  ...patch,
})

const change = (id: string, baseRev: number | null, patch: Partial<Reagent> = {}): PushChange => ({
  kind: 'reagent',
  id,
  baseRev,
  record: reagent(id, patch),
})

let db: SqliteD1

beforeEach(() => {
  db = new SqliteD1()
})

/**
 * 基準実装（MemorySyncServer）と D1 実装に同じ操作を流し、同じ結果になることを確かめる。
 * rev の値そのものも一致する（どちらもユーザーごとの通し番号）。
 */
describe('D1 実装は基準実装と同じ規則で動く', () => {
  const scenarios: { name: string; steps: PushChange[][] }[] = [
    { name: '新規作成', steps: [[change('a', null), change('b', null)]] },
    {
      name: '正しい baseRev での更新は通り、古い baseRev は競合',
      steps: [[change('a', null)], [change('a', 1, { name: 'v2' })], [change('a', 1, { name: 'stale' })]],
    },
    { name: 'サーバーにあるのに baseRev が null なら競合', steps: [[change('a', null)], [change('a', null)]] },
    {
      name: 'サーバーに無いレコードは baseRev に関わらず受け付ける',
      steps: [[change('a', 7)]],
    },
    {
      name: '同じ push の中で成功と競合が混ざる',
      steps: [[change('a', null), change('b', null)], [change('a', 1, { name: 'ok' }), change('b', 99), change('c', null)]],
    },
    {
      name: '墓標',
      steps: [[change('a', null)], [change('a', 1, { deletedAt: 5, updatedAt: 5 })]],
    },
  ]

  for (const s of scenarios) {
    it(s.name, async () => {
      const ref = new MemorySyncServer()
      for (const step of s.steps) {
        const expected = ref.push({ changes: structuredClone(step) })
        const actual = await push(db, 'user-a', structuredClone(step))
        expect(actual).toEqual(expected)
      }
      expect(await pull(db, 'user-a', 0, 100)).toEqual(ref.pull(0, 100))
    })
  }
})

describe('D1 実装: push', () => {
  it('ユーザー同士は完全に分かれている（同じ ID でも別レコード・rev も別系列）', async () => {
    await push(db, 'user-a', [change('shared', null, { name: 'A' })])
    await push(db, 'user-b', [change('shared', null, { name: 'B' })])
    const a = await pull(db, 'user-a', 0, 100)
    const b = await pull(db, 'user-b', 0, 100)
    expect(a.changes.map((c) => (c.record as Reagent).name)).toEqual(['A'])
    expect(b.changes.map((c) => (c.record as Reagent).name)).toEqual(['B'])
    expect(b.changes[0]!.rev).toBe(1)
    // 他人のレコードの rev を baseRev にしても他人のデータは変わらない
    await push(db, 'user-b', [change('shared', 1, { name: 'B2' })])
    expect(((await pull(db, 'user-a', 0, 100)).changes[0]!.record as Reagent).name).toBe('A')
  })

  it('本文に rev は保存せず、返すときに列の値を付ける', async () => {
    await push(db, 'user-a', [{ ...change('a', null), record: { ...reagent('a'), rev: 999 } }])
    const row = db.db.prepare('SELECT rev, body FROM records').get() as { rev: number; body: string }
    expect(row.rev).toBe(1)
    expect(JSON.parse(row.body).rev).toBeUndefined()
    expect((await pull(db, 'user-a', 0, 10)).changes[0]!.record.rev).toBe(1)
  })

  it(`最大件数（${PUSH_BATCH_LIMIT} 件・全件競合）でも D1 のクエリ数は Free の上限 50 に収まる`, async () => {
    const ids = Array.from({ length: PUSH_BATCH_LIMIT }, (_, i) => `r${i}`)
    await push(db, 'user-a', ids.map((id) => change(id, null)))
    db.queries = 0
    const res = await push(db, 'user-a', ids.map((id) => change(id, null)))
    expect(res.results.every((r) => r.status === 'conflict')).toBe(true)
    expect(db.queries).toBeLessThanOrEqual(50)
  })

  it('batch の途中で失敗したら全体が巻き戻る（採番が飛ばない）', async () => {
    const original = db.batch.bind(db)
    db.batch = async (stmts) => {
      // 2 文目を壊す
      const broken = [stmts[0]!, db.prepare('INSERT INTO nope VALUES (1)'), ...stmts.slice(2)]
      return original(broken)
    }
    await expect(push(db, 'user-a', [change('a', null), change('b', null), change('c', null)])).rejects.toThrow()
    db.batch = original
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
    const r = await push(db, 'user-a', [change('a', null)])
    expect(r.results[0]).toMatchObject({ status: 'ok', rev: 1 })
  })
})

describe('D1 実装: pull', () => {
  it('rev 順にページを分けて返し、cursor は最後の rev', async () => {
    await push(db, 'user-a', ['a', 'b', 'c', 'd', 'e'].map((id) => change(id, null)))
    const p1 = await pull(db, 'user-a', 0, 2)
    expect(p1.changes.map((c) => c.id)).toEqual(['a', 'b'])
    expect(p1).toMatchObject({ cursor: 2, hasMore: true })
    const p3 = await pull(db, 'user-a', 4, 2)
    expect(p3.changes.map((c) => c.id)).toEqual(['e'])
    expect(p3).toMatchObject({ cursor: 5, hasMore: false })
    expect(await pull(db, 'user-a', 5, 2)).toEqual({ changes: [], cursor: 5, hasMore: false })
  })

  it('更新されたレコードは新しい rev の位置に移る（古い位置では返らない）', async () => {
    await push(db, 'user-a', [change('a', null), change('b', null)])
    await push(db, 'user-a', [change('a', 1, { name: 'v2' })])
    const all = await pull(db, 'user-a', 0, 10)
    expect(all.changes.map((c) => [c.id, c.rev])).toEqual([
      ['b', 2],
      ['a', 3],
    ])
  })
})

describe('D1 実装: 容量上限', () => {
  const usage = (userId = 'user-a') =>
    db.db.prepare('SELECT records, bytes FROM sync_usage WHERE user_id = ?').get(userId) as Quota | undefined
  /** トリガーを通さずに数え直した値 */
  const recount = (userId = 'user-a') =>
    db.db
      .prepare(
        'SELECT COUNT(*) AS records, SUM(length(CAST(body AS BLOB))) AS bytes FROM records WHERE user_id = ?',
      )
      .get(userId) as Quota | undefined
  const count = () => (db.db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n

  it('使用量（sync_usage）は作成・更新・墓標・競合・物理削除のあとも数え直した値と一致する', async () => {
    await push(db, 'user-a', [change('a', null), change('b', null, { name: 'ｂ'.repeat(50) })])
    await push(db, 'user-a', [change('a', 1, { name: 'long'.repeat(100) }), change('b', 99)])
    await push(db, 'user-a', [change('b', 2, { deletedAt: 5, updatedAt: 5 })])
    await push(db, 'user-b', [change('a', null)])
    expect(usage()).toEqual(recount())
    expect(usage()!.records).toBe(2)
    expect(usage('user-b')).toEqual(recount('user-b'))
    db.db.prepare("DELETE FROM records WHERE user_id = 'user-a' AND id = 'a'").run()
    expect(usage()).toEqual(recount())
  })

  it('bytes は文字数ではなく UTF-8 のバイト数', async () => {
    await push(db, 'user-a', [change('a', null, { name: 'あ'.repeat(100) })])
    const body = (db.db.prepare('SELECT body FROM records').get() as { body: string }).body
    expect(usage()!.bytes).toBe(new TextEncoder().encode(body).byteLength)
    expect(usage()!.bytes).toBeGreaterThan(body.length)
  })

  it('0003 の適用時に、既存のレコードから使用量を作る', async () => {
    // 0003 より前の Worker（容量の確認なし）が書いたデータ。今の push は sync_usage を読むので SQL で入れる
    db = new SqliteD1('0003')
    const insert = db.db.prepare(
      "INSERT INTO records (user_id, kind, id, rev, updated_at, deleted, body) VALUES (?, 'reagent', ?, ?, 1, 0, ?)",
    )
    insert.run('user-a', 'a', 1, JSON.stringify(reagent('a', { name: 'あいう' })))
    insert.run('user-a', 'b', 2, JSON.stringify(reagent('b')))
    insert.run('user-b', 'c', 1, JSON.stringify(reagent('c')))
    db.migrate('0003_sync_usage.sql')
    expect(usage()).toEqual({ ...recount(), records: 2 })
    expect(usage('user-b')).toEqual({ ...recount('user-b'), records: 1 })
  })

  it('件数の上限を超える push は丸ごと断り、何も書かない', async () => {
    const quota = { records: 3, bytes: 1e9 }
    await push(db, 'user-a', [change('a', null), change('b', null)], quota)
    await expect(push(db, 'user-a', [change('c', null), change('d', null)], quota)).rejects.toThrow(QuotaExceeded)
    expect(count()).toBe(2)
    // ちょうど上限までは書ける。既存の更新は件数を増やさないので上限でも通る
    await push(db, 'user-a', [change('c', null)], quota)
    const r = await push(db, 'user-a', [change('a', 1, { name: 'v2' })], quota)
    expect(r.results[0]).toMatchObject({ status: 'ok' })
    // 他のユーザーには影響しない
    await push(db, 'user-b', [change('a', null)], quota)
  })

  it('バイト数の上限: 超える push は断り、上限に達したあとも小さくする編集は通る', async () => {
    await push(db, 'user-a', [change('a', null, { name: 'x'.repeat(1000) })])
    const quota = { records: 100, bytes: usage()!.bytes + 100 }
    const err = await push(db, 'user-a', [change('b', null, { name: 'y'.repeat(200) })], quota).catch((e) => e)
    expect(err).toBeInstanceOf(QuotaExceeded)
    expect(err.usage).toEqual(usage())
    expect(count()).toBe(1)
    // 既存の本文を差し引いて判定する（大きいレコードを小さくし、空いた分で新しいものを作る）
    const r = await push(db, 'user-a', [change('a', 1, { name: 'x' }), change('b', null, { name: 'y'.repeat(200) })], quota)
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok'])
  })

  it('上限を超えた後でも、使用量を増やさない push（墓標で小さくなる等）は通る', async () => {
    await push(db, 'user-a', [change('a', null, { name: 'x'.repeat(500) }), change('b', null)])
    const tight = { records: 1, bytes: 10 } // 既に両方とも超えている
    const r = await push(db, 'user-a', [change('a', 1, { name: 'x', deletedAt: 9, updatedAt: 9 })], tight)
    expect(r.results[0]).toMatchObject({ status: 'ok' })
    await expect(push(db, 'user-a', [change('a', 3, { name: 'x'.repeat(600) })], tight)).rejects.toThrow(QuotaExceeded)
  })
})

describe('端から端まで: 2 台の端末 → HttpTransport → Worker → D1', () => {
  let auth: TestAuth

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    auth = await createTestAuth()
  })

  /** fetch の代わりに Worker の handle を直接呼ぶ */
  function device(name: string, userId: string) {
    const env: Env = { DB: db, SYNC_ALLOWED_USER_IDS: 'user-1,user-2' }
    const transport = new HttpTransport({
      baseUrl: 'https://colloion.tomu-ai.dev',
      getToken: () => auth.token(userId),
      fetch: async (input, init) => handle(new Request(input as string, init), env, { authConfig: auth.config }),
    })
    const store = new IndexedDbAdapter(`e2e-${name}`)
    return { store, engine: new SyncEngine(store, transport) }
  }

  it('母液を 2 台で別々に使い、削除も伝わる', async () => {
    const a = device('a', 'user-1')
    const b = device('b', 'user-1')
    await a.engine.attach('user-1')
    await b.engine.attach('user-1')

    const stock: Stock = {
      id: 'st1',
      reagentId: 'seed-na2co3',
      molarity: 1,
      preparedAt: '2026-10-13T00:00:00.000Z',
      initialVolumeMl: 100,
      usages: [],
      updatedAt: 1,
    }
    await a.store.saveStock(stock)
    await a.engine.syncOnce()
    await b.engine.syncOnce()

    const sa = (await a.store.getRecord('stock', 'st1'))!
    await a.store.saveStock({ ...sa, usages: [{ id: 'ua', at: 2, doseMl: 0.5 }], updatedAt: 2 })
    const sb = (await b.store.getRecord('stock', 'st1'))!
    await b.store.saveStock({ ...sb, usages: [{ id: 'ub', at: 3, doseMl: 0.25 }], updatedAt: 3 })
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    for (const d of [a, b]) {
      expect((await d.store.getRecord('stock', 'st1'))!.usages.map((u) => u.id)).toEqual(['ua', 'ub'])
    }

    await b.store.deleteStock('st1')
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    expect(await a.store.listStocks()).toHaveLength(0)
    expect(a.engine.getStatus()).toMatchObject({ phase: 'idle', pending: 0 })
  })

  it('別ユーザーのデータは届かない', async () => {
    const a = device('a', 'user-1')
    const c = device('c', 'user-2')
    await a.engine.attach('user-1')
    await c.engine.attach('user-2')
    await a.store.saveReagent(reagent('private'))
    await a.engine.syncOnce()
    await c.engine.syncOnce()
    expect(await c.store.getRecord('reagent', 'private')).toBeUndefined()
  })

  it('許可リストに無いユーザーは forbidden で止まり、再試行しない', async () => {
    const x = device('x', 'stranger')
    await x.engine.attach('stranger')
    await x.store.saveReagent(reagent('mine'))
    await expect(x.engine.syncOnce()).rejects.toThrow()
    expect(x.engine.getStatus()).toMatchObject({ phase: 'forbidden', pending: 1 })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
  })

  it('容量上限なら 507 → quota で止まり、送信待ちは残る。pull は通る', async () => {
    const env: Env = { DB: db, SYNC_ALLOWED_USER_IDS: 'user-1' }
    const transport = new HttpTransport({
      baseUrl: 'https://colloion.tomu-ai.dev',
      getToken: () => auth.token('user-1'),
      fetch: async (input, init) =>
        handle(new Request(input as string, init), env, {
          authConfig: auth.config,
          quota: { records: 1, bytes: 1e9 },
        }),
    })
    await push(db, 'user-1', [change('from-other-device', null)])
    const store = new IndexedDbAdapter('e2e-quota')
    const engine = new SyncEngine(store, transport)
    await engine.attach('user-1')
    await store.saveReagent(reagent('new'))
    await expect(engine.syncOnce()).rejects.toThrow()
    expect(engine.getStatus()).toMatchObject({ phase: 'quota', pending: 1 })
    expect(await store.getRecord('reagent', 'from-other-device')).toBeDefined()
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
  })

  it('トークンが期限切れなら unauthorized で止まる', async () => {
    const env: Env = { DB: db, SYNC_ALLOWED_USER_IDS: 'user-1' }
    const transport = new HttpTransport({
      baseUrl: 'https://colloion.tomu-ai.dev',
      getToken: () => auth.token('user-1', { expiresIn: '-1m' }),
      fetch: async (input, init) => handle(new Request(input as string, init), env, { authConfig: auth.config }),
    })
    const engine = new SyncEngine(new IndexedDbAdapter('e2e-expired'), transport)
    await expect(engine.syncOnce()).rejects.toThrow()
    expect(engine.getStatus().phase).toBe('unauthorized')
  })
})
