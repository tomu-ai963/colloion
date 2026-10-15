import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Batch, Reagent, Stock } from '../core/model'
import { createSession } from '../core/session'
import { stockRemainingMl } from '../core/stock'
import { IndexedDbAdapter } from '../storage/indexedDbAdapter'
import { MemoryAdapter } from '../storage/memoryAdapter'
import { DEBOUNCE_MS, MAX_PUSH_ROUNDS, MIN_INTERVAL_MS, SyncEngine } from './engine'
import { MemorySyncServer } from './memoryServer'
import { PUSH_BATCH_LIMIT, SyncAuthError, SyncForbiddenError, type SyncTransport } from './protocol'

const T = 1_760_000_000_000

const makeBatch = (id: string, patch: Partial<Batch> = {}): Batch => ({
  id,
  label: '2026-1013-01',
  createdAt: new Date(T).toISOString(),
  updatedAt: T,
  mode: 'colloid',
  water: { volumeMl: 1000, type: '蒸留水', initialTds: 1, tempC: 24 },
  electrode: { anode: 'Ag', cathode: '銀 Ag', purity: '99.99%', areaCm2: 12, gapMm: 35, route: 'electrolysis' },
  additives: [],
  power: { mode: 'CC', currentMa: 1, voltageV: 24, durationSec: 10800, eta: 92, reversalMin: 15 },
  computed: { mg: 11.1, ppm: 11.1, coulombs: 10.8, currentDensity: 0.083 },
  ...patch,
})

const makeStock = (patch: Partial<Stock> = {}): Stock => ({
  id: 'st1',
  reagentId: 'seed-na2co3',
  molarity: 1,
  preparedAt: new Date(T).toISOString(),
  initialVolumeMl: 100,
  usages: [],
  updatedAt: T,
  ...patch,
})

/** 1 台の端末 = 自分の IndexedDB + エンジン */
function device(name: string, server: MemorySyncServer, transport?: SyncTransport) {
  const store = new IndexedDbAdapter(`device-${name}`)
  const engine = new SyncEngine(store, transport ?? server.transport())
  return { store, engine }
}

let server: MemorySyncServer

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  server = new MemorySyncServer()
})

describe('SyncEngine: 2 台の端末間の同期', () => {
  it('A で保存したバッチが B に届き、送信待ちが空になる', async () => {
    const a = device('a', server)
    const b = device('b', server)
    await a.engine.attach('user-1')
    await b.engine.attach('user-1')

    await a.store.saveBatch(makeBatch('b1'))
    expect(await a.store.countOutbox()).toBe(1)
    const ra = await a.engine.syncOnce()
    expect(ra.pushed).toBe(1)
    expect(await a.store.countOutbox()).toBe(0)
    expect((await a.store.getRecord('batch', 'b1'))!.rev).toBeGreaterThan(0)

    const rb = await b.engine.syncOnce()
    expect(rb.pulled).toBe(1)
    expect((await b.store.listBatches()).map((x) => x.id)).toEqual(['b1'])
    expect(await b.store.countOutbox()).toBe(0)
  })

  it('初回の attach で既存データをまとめて送る。同じユーザーで再 attach しても積み直さない', async () => {
    const a = device('a', server)
    await a.store.saveBatch(makeBatch('old'))
    await a.store.ackOutbox([{ key: 'batch:old', n: 1 }]) // ログイン前に積まれた分が無い状態を模す
    expect(await a.store.countOutbox()).toBe(0)

    await a.engine.attach('user-1')
    expect(await a.store.countOutbox()).toBe(1)
    await a.engine.syncOnce()
    expect(server.get('batch', 'old')).toBeDefined()

    await a.engine.attach('user-1')
    expect(await a.store.countOutbox()).toBe(0)
  })

  it('2 台で同じ母液を別々に使っても、両方の使用記録が残る（競合 → 和集合）', async () => {
    const a = device('a', server)
    const b = device('b', server)
    await a.engine.attach('u')
    await b.engine.attach('u')
    await a.store.saveStock(makeStock())
    await a.engine.syncOnce()
    await b.engine.syncOnce()

    // 両端末がオフラインの間にそれぞれ使った
    const sa = (await a.store.getRecord('stock', 'st1'))!
    await a.store.saveStock({ ...sa, usages: [{ id: 'ua', at: T + 1, doseMl: 0.5 }], updatedAt: T + 1 })
    const sb = (await b.store.getRecord('stock', 'st1'))!
    await b.store.saveStock({ ...sb, usages: [{ id: 'ub', at: T + 2, doseMl: 0.25 }], updatedAt: T + 2 })

    await a.engine.syncOnce()
    const r = await b.engine.syncOnce() // B は pull でマージしてから送る
    expect(r.conflicts).toBe(0)
    await a.engine.syncOnce()

    for (const d of [a, b]) {
      const s = (await d.store.getRecord('stock', 'st1'))!
      expect(s.usages.map((u) => u.id)).toEqual(['ua', 'ub'])
      expect(stockRemainingMl(s)).toBeCloseTo(99.25, 10)
      expect(await d.store.countOutbox()).toBe(0)
    }
    expect((server.get('stock', 'st1') as Stock).usages).toHaveLength(2)
  })

  it('push 時の競合（pull と push の間に他端末が書いた）もマージして送り直す', async () => {
    const a = device('a', server)
    let beforePush: (() => Promise<void>) | null = null
    const raw = server.transport()
    const b = device('b', server, {
      pull: raw.pull,
      push: async (req) => {
        await beforePush?.()
        return raw.push(req)
      },
    })
    await a.engine.attach('u')
    await b.engine.attach('u')
    await a.store.saveStock(makeStock())
    await a.engine.syncOnce()
    await b.engine.syncOnce()

    const sb = (await b.store.getRecord('stock', 'st1'))!
    await b.store.saveStock({ ...sb, usages: [{ id: 'ub', at: T + 2, doseMl: 0.25 }], updatedAt: T + 2 })
    beforePush = async () => {
      beforePush = null
      const sa = (await a.store.getRecord('stock', 'st1'))!
      await a.store.saveStock({ ...sa, usages: [{ id: 'ua', at: T + 1, doseMl: 0.5 }], updatedAt: T + 1 })
      await a.engine.syncOnce()
    }
    const r = await b.engine.syncOnce()
    expect(r.conflicts).toBe(1)
    expect((server.get('stock', 'st1') as Stock).usages.map((u) => u.id)).toEqual(['ua', 'ub'])
    expect(await b.store.countOutbox()).toBe(0)
  })

  it('削除と編集が競合したら削除が残る', async () => {
    const a = device('a', server)
    const b = device('b', server)
    await a.engine.attach('u')
    await b.engine.attach('u')
    await a.store.saveBatch(makeBatch('b1'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()

    await a.store.deleteBatch('b1')
    const bb = (await b.store.getRecord('batch', 'b1'))!
    await b.store.saveBatch({ ...bb, result: { verdict: '良' }, updatedAt: Date.now() + 1000 })
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await a.engine.syncOnce()

    expect(await a.store.listBatches()).toHaveLength(0)
    expect(await b.store.listBatches()).toHaveLength(0)
    expect(server.get('batch', 'b1')!.deletedAt).toBeDefined()
  })

  it('セッションは開いた端末の版が正。他端末からは読み取り専用で届く', async () => {
    const a = device('a', server)
    const b = device('b', server)
    await a.engine.attach('u')
    await b.engine.attach('u')
    const aId = await a.store.getDeviceId()
    const s = createSession('s1', 'b1', aId, T, 1)
    await a.store.saveSession(s)
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect((await b.store.getRecord('session', 's1'))!.deviceId).toBe(aId)

    // A が通電を続けて更新、B は届いた版を（誤って）書き換えて送ってしまった
    await a.store.saveSession({ ...s, marks: [{ at: T + 5, kind: 'note', text: 'A' }], updatedAt: T + 5 })
    const sb = (await b.store.getRecord('session', 's1'))!
    await b.store.saveSession({ ...sb, marks: [{ at: T + 9, kind: 'note', text: 'B' }], updatedAt: T + 9 })
    await b.engine.syncOnce()
    await a.engine.syncOnce() // A は自分のセッションなので自分の版で上書きし直す
    await b.engine.syncOnce()

    for (const d of [a, b]) {
      expect((await d.store.getRecord('session', 's1'))!.marks.map((m) => m.text)).toEqual(['A'])
    }
  })

  it('送信中に同じレコードが更新されたら、その更新は消えずに次のラウンドで送られる', async () => {
    let during: (() => Promise<void>) | null = null
    const raw = server.transport()
    const a = device('a', server, {
      pull: raw.pull,
      push: async (req) => {
        const res = await raw.push(req)
        await during?.()
        return res
      },
    })
    await a.engine.attach('u')
    await a.store.saveBatch(makeBatch('b1'))
    during = async () => {
      during = null
      const cur = (await a.store.getRecord('batch', 'b1'))!
      await a.store.saveBatch({ ...cur, result: { measuredTds: 7 }, updatedAt: T + 50 })
    }
    const r = await a.engine.syncOnce()

    // 新しい書き込みは消えず、送った版の rev を元に（競合せず）同じ同期の中で送られる
    expect(r).toMatchObject({ pushed: 2, conflicts: 0 })
    const local = (await a.store.getRecord('batch', 'b1'))!
    expect(local.result?.measuredTds).toBe(7)
    expect(local.rev).toBe(server.get('batch', 'b1')!.rev)
    expect(await a.store.countOutbox()).toBe(0)
    expect((server.get('batch', 'b1') as Batch).result?.measuredTds).toBe(7)
  })

  it('同期前の古い状態から保存しても、届いていた使用記録を消さない', async () => {
    const a = device('a', server)
    const b = device('b', server)
    await a.engine.attach('u')
    await b.engine.attach('u')
    await a.store.saveStock(makeStock())
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    const staleOnB = (await b.store.getRecord('stock', 'st1'))! // B のアプリが持っている状態

    const sa = (await a.store.getRecord('stock', 'st1'))!
    await a.store.saveStock({ ...sa, usages: [{ id: 'ua', at: T + 1, doseMl: 0.5 }], updatedAt: T + 1 })
    await a.engine.syncOnce()
    await b.engine.syncOnce() // ua が B の DB に届く（アプリの状態はまだ古い）

    await b.store.saveStock({ ...staleOnB, usages: [{ id: 'ub', at: T + 2, doseMl: 0.25 }], updatedAt: T + 2 })
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    for (const d of [a, b]) {
      expect((await d.store.getRecord('stock', 'st1'))!.usages.map((u) => u.id)).toEqual(['ua', 'ub'])
    }
  })

  it('pull はページを跨いで最後まで取り込む', async () => {
    const a = device('a', server)
    const b = device('b', server, server.transport({ pullLimit: 2 }))
    await a.engine.attach('u')
    await b.engine.attach('u')
    for (let i = 0; i < 5; i++) await a.store.saveBatch(makeBatch(`b${i}`))
    await a.engine.syncOnce()
    const r = await b.engine.syncOnce()
    expect(r.pulled).toBe(5)
    expect(await b.store.listBatches()).toHaveLength(5)
  })
})

describe('SyncEngine: 失敗時', () => {
  it('オフラインなら送信待ちを残して offline になり、復帰後に送れる', async () => {
    let offline = true
    const statuses: string[] = []
    const store = new IndexedDbAdapter('offline-test')
    const engine = new SyncEngine(store, server.transport({ offline: () => offline }), {
      onStatus: (s) => statuses.push(s.phase),
    })
    await engine.attach('u')
    await store.saveBatch(makeBatch('b1'))
    await expect(engine.syncOnce()).rejects.toThrow()
    expect(engine.getStatus().phase).toBe('offline')
    expect(engine.getStatus().pending).toBe(1)

    offline = false
    await engine.syncOnce()
    expect(engine.getStatus()).toMatchObject({ phase: 'idle', pending: 0 })
    expect(server.get('batch', 'b1')).toBeDefined()
    engine.stop()
  })

  it('認証切れ（401）は unauthorized で止まり、自動で再試行しない', async () => {
    vi.useFakeTimers()
    try {
      const pull = vi.fn(async () => {
        throw new SyncAuthError()
      })
      const store = new MemoryAdapter()
      const engine = new SyncEngine(store, { pull, push: vi.fn() })
      await expect(engine.syncOnce()).rejects.toBeInstanceOf(SyncAuthError)
      expect(engine.getStatus().phase).toBe('unauthorized')
      engine.requestSync()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(pull).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SyncEngine: 同期の対象外（403）', () => {
  it('forbidden で止まり、書き込みがあっても自動で再試行しない', async () => {
    vi.useFakeTimers()
    try {
      const pull = vi.fn(async () => {
        throw new SyncForbiddenError()
      })
      const store = new MemoryAdapter()
      const engine = new SyncEngine(store, { pull, push: vi.fn() })
      await expect(engine.syncOnce()).rejects.toBeInstanceOf(SyncForbiddenError)
      expect(engine.getStatus().phase).toBe('forbidden')
      engine.requestSync()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(pull).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SyncEngine: 送信の予約', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start 直後に1回、書き込みのあとは前回から MIN_INTERVAL_MS 空けて同期する', async () => {
    const store = new MemoryAdapter()
    const transport = server.transport()
    const pull = vi.spyOn(transport, 'pull')
    const engine = new SyncEngine(store, transport)
    await engine.attach('u')
    engine.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(pull).toHaveBeenCalledTimes(1)

    // Run Mode のような連続書き込み
    for (let i = 0; i < 5; i++) {
      await store.saveBatch(makeBatch('b1', { updatedAt: T + i }))
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    }
    expect(pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS)
    expect(pull).toHaveBeenCalledTimes(2)
    expect(server.get('batch', 'b1')!.updatedAt).toBe(T + 4)
    engine.stop()
  })
})

describe('SyncEngine: 送信待ちが多いとき', () => {
  const reagent = (i: number): Reagent => ({
    id: `r${i}`,
    name: `試薬${i}`,
    formula: 'NaCl',
    mw: 58.44,
    purityPct: 100,
    role: '電解質',
    updatedAt: T,
  })

  afterEach(() => vi.useRealTimers())

  it(`${PUSH_BATCH_LIMIT} 件を超えても 1 回の同期で送り切る`, async () => {
    const store = new MemoryAdapter()
    const engine = new SyncEngine(store, server.transport())
    await engine.attach('user-1')
    for (let i = 0; i < 100; i++) await store.saveReagent(reagent(i))
    const report = await engine.syncOnce()
    expect(report.pushed).toBe(100)
    expect(engine.getStatus().pending).toBe(0)
    expect(server.pull(0, 1000).changes).toHaveLength(100)
  })

  it('1 回の同期のラウンド上限を超えた分は、間隔を空けて続けて送る', async () => {
    vi.useFakeTimers()
    const store = new MemoryAdapter()
    const engine = new SyncEngine(store, server.transport())
    await engine.attach('user-1')
    const total = MAX_PUSH_ROUNDS * PUSH_BATCH_LIMIT + 10
    for (let i = 0; i < total; i++) await store.saveReagent(reagent(i))

    const report = await engine.syncOnce()
    expect(report.pushed).toBe(MAX_PUSH_ROUNDS * PUSH_BATCH_LIMIT)
    expect(engine.getStatus()).toMatchObject({ phase: 'idle', pending: 10 })

    // 書き込みや定期の同期が無くても、MIN_INTERVAL_MS 後に残りが送られる
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS)
    expect(engine.getStatus().pending).toBe(0)
    expect(server.pull(0, 2000).changes).toHaveLength(total)
    engine.stop()
  })

  it('同じレコードが競合し続けても、同期は終わる', async () => {
    let pushes = 0
    const transport: SyncTransport = {
      pull: async (since) => ({ changes: [], cursor: since, hasMore: false }),
      // サーバーには常に古い版があり、何度送っても競合を返す（ありえないが、止まることを確かめる）
      push: async (req) => {
        pushes++
        return {
          results: req.changes.map((c) => ({
            kind: c.kind,
            id: c.id,
            status: 'conflict' as const,
            current: { ...c.record, updatedAt: 1, rev: 1 },
          })),
        }
      },
    }
    const store = new MemoryAdapter()
    const engine = new SyncEngine(store, transport)
    await engine.attach('user-1')
    await store.saveReagent(reagent(0))
    await engine.syncOnce()
    expect(pushes).toBe(3)
    expect(engine.getStatus()).toMatchObject({ phase: 'idle', pending: 1 })
  })
})
