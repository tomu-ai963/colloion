import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import { stockRemainingMl } from '../core/stock'
import { IndexedDbAdapter } from './indexedDbAdapter'

// 実ブラウザと同じ IndexedDB API でスキーマ移行を通す（テストごとに空の DB）
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

/** v2 時点のスキーマとレコードを再現する */
async function seedV2(dbName: string) {
  const db = await openDB(dbName, 2, {
    upgrade(db) {
      for (const s of ['batches', 'reagents', 'stocks', 'pipettes', 'sessions']) {
        db.createObjectStore(s, { keyPath: 'id' })
      }
    },
  })
  await db.put('batches', { id: 'b1', label: '2026-0801-01', createdAt: '2026-08-01T10:00:00.000Z' })
  await db.put('reagents', { id: 'seed-nacl', name: '塩化ナトリウム', formula: 'NaCl', mw: 58.44 })
  await db.put('reagents', { id: 'user-1', name: '登録', formula: 'KNO3', mw: 101.1 })
  await db.put('stocks', {
    id: 's1',
    reagentId: 'seed-nacl',
    molarity: 1,
    preparedAt: '2026-08-02T00:00:00.000Z',
    volumeRemainingMl: 73.5,
  })
  await db.put('pipettes', { id: 'default-pipette', name: '標準スポイト', mlPer20Drops: 1.1 })
  await db.put('sessions', { id: 'sess1', batchId: 'b1', startedAt: 1, status: 'running', updatedAt: 1 })
  db.close()
}

describe('IndexedDbAdapter: v2 → v3 の移行', () => {
  it('既存レコードに同期メタ情報が補完され、表示上の値は変わらない', async () => {
    await seedV2('migrate-test')
    const st = new IndexedDbAdapter('migrate-test')

    const [batch] = await st.listBatches()
    expect(batch!.updatedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))

    const reagents = await st.listReagents()
    expect(reagents.find((r) => r.id === 'seed-nacl')!.updatedAt).toBe(0)
    expect(reagents.find((r) => r.id === 'user-1')!.updatedAt).toBeGreaterThan(0)

    const [stock] = await st.listStocks()
    expect(stock!.initialVolumeMl).toBe(73.5)
    expect(stock!.usages).toEqual([])
    expect(stockRemainingMl(stock!)).toBe(73.5)
    expect('volumeRemainingMl' in stock!).toBe(false)

    const [pipette] = await st.listPipettes()
    expect(pipette!.mlPer20Drops).toBe(1.1)
    expect(pipette!.updatedAt).toBeGreaterThan(0)

    // 旧セッションは移行時に生成した端末 ID のもの（＝復帰対象として残る）
    const deviceId = await st.getDeviceId()
    const [session] = await st.listSessions()
    expect(session!.deviceId).toBe(deviceId)
  })

  it('端末 ID は開き直しても変わらない', async () => {
    const a = await new IndexedDbAdapter('device-test').getDeviceId()
    const b = await new IndexedDbAdapter('device-test').getDeviceId()
    expect(a).toBeTruthy()
    expect(b).toBe(a)
  })

  it('削除は墓標として残り、一覧には出ない', async () => {
    const st = new IndexedDbAdapter('tombstone-test')
    await st.saveReagent({
      id: 'r1',
      name: 'x',
      formula: 'NaCl',
      mw: 58.44,
      purityPct: 100,
      role: '電解質',
      updatedAt: 1,
    })
    await st.deleteReagent('r1')
    expect(await st.listReagents()).toHaveLength(0)

    const raw = await openDB('tombstone-test')
    const tomb = await raw.get('reagents', 'r1')
    raw.close()
    expect(tomb.deletedAt).toBeGreaterThan(0)
    expect(tomb.updatedAt).toBe(tomb.deletedAt)
  })
})

describe('IndexedDbAdapter: 送信待ちキュー（v4）', () => {
  const reagent = (updatedAt: number) => ({
    id: 'r1',
    name: 'x',
    formula: 'NaCl',
    mw: 58.44,
    purityPct: 100,
    role: '電解質' as const,
    updatedAt,
  })

  it('v3 の outbox（保存ごとに1行）は作り直され、既存データは残る', async () => {
    const v3 = await openDB('v3-test', 3, {
      upgrade(db) {
        for (const s of ['batches', 'reagents', 'stocks', 'pipettes', 'sessions']) {
          db.createObjectStore(s, { keyPath: 'id' })
        }
        db.createObjectStore('meta')
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true })
      },
    })
    await v3.put('meta', 'dev-v3', 'deviceId')
    await v3.put('reagents', reagent(5))
    await v3.add('outbox', { kind: 'reagent', id: 'r1', queuedAt: 1 })
    v3.close()

    const st = new IndexedDbAdapter('v3-test')
    expect(await st.getDeviceId()).toBe('dev-v3')
    expect(await st.listReagents()).toHaveLength(1)
    expect(await st.countOutbox()).toBe(0)
    await st.saveReagent(reagent(6))
    expect((await st.readOutbox(10))[0]).toMatchObject({ key: 'reagent:r1', n: 1 })
  })

  it('同じレコードを何度保存しても送信待ちは1件で、版番号 n が進む', async () => {
    const st = new IndexedDbAdapter('outbox-test')
    for (let i = 0; i < 10; i++) await st.saveReagent(reagent(i))
    const entries = await st.readOutbox(100)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.n).toBe(10)

    // 古い版番号での ack は消さない（送信中に書き込みがあった場合）
    await st.ackOutbox([{ key: 'reagent:r1', n: 9 }])
    expect(await st.countOutbox()).toBe(1)
    await st.ackOutbox([{ key: 'reagent:r1', n: 10 }])
    expect(await st.countOutbox()).toBe(0)
  })

  it('保存で rev を下げない（アプリの状態は rev を知らないことがある）', async () => {
    const st = new IndexedDbAdapter('rev-test')
    await st.saveReagent(reagent(1))
    await st.updateRecord('reagent', 'r1', (cur) => ({ next: { ...cur!, rev: 42 } }))
    await st.saveReagent(reagent(2)) // rev 無しで保存
    expect((await st.getRecord('reagent', 'r1'))!.rev).toBe(42)
  })

  it('アプリからの書き込みを通知する', async () => {
    const st = new IndexedDbAdapter('notify-test')
    let count = 0
    const off = st.onLocalChange(() => count++)
    await st.saveReagent(reagent(1))
    await st.deleteReagent('r1')
    await st.deleteReagent('missing') // 何も書かないので通知しない
    off()
    await st.saveReagent(reagent(2))
    expect(count).toBe(2)
  })
})
