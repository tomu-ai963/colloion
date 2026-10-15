import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import { stockRemainingMl } from '../core/stock'
import {
  BACKUP_FORMAT,
  BackupFormatError,
  IMPORTED_DEVICE_ID,
  backupFilename,
  buildBackup,
  parseBackup,
  resolveImport,
} from './backup'
import { IndexedDbAdapter } from './indexedDbAdapter'
import { MemoryAdapter } from './memoryAdapter'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

const batch = (over: Partial<Batch> = {}): Batch => ({
  id: 'b1',
  label: '2026-1015-01',
  createdAt: '2026-10-15T01:00:00.000Z',
  updatedAt: 1000,
  mode: 'colloid',
  water: { volumeMl: 1000, type: '蒸留水', initialTds: 1, tempC: 24 },
  electrode: { anode: 'Ag', cathode: '銀 Ag', purity: '99.99%', areaCm2: 12, gapMm: 35, route: 'electrolysis' },
  additives: [],
  power: { mode: 'CC', currentMa: 1, voltageV: 24, durationSec: 10800, eta: 95, reversalMin: 15 },
  computed: { mg: 12.1, ppm: 12.1, coulombs: 10.8, currentDensity: 0.083 },
  ...over,
})

const reagent = (over: Partial<Reagent> = {}): Reagent => ({
  id: 'r1',
  name: '硝酸カリウム',
  formula: 'KNO3',
  mw: 101.1,
  purityPct: 99,
  role: '電解質',
  updatedAt: 1000,
  ...over,
})

const stock = (over: Partial<Stock> = {}): Stock => ({
  id: 's1',
  reagentId: 'r1',
  molarity: 1,
  preparedAt: '2026-10-15T00:00:00.000Z',
  initialVolumeMl: 100,
  usages: [],
  updatedAt: 1000,
  ...over,
})

const pipette = (over: Partial<Pipette> = {}): Pipette => ({
  id: 'default-pipette',
  name: '標準スポイト',
  mlPer20Drops: 1.1,
  updatedAt: 1000,
  ...over,
})

const session = (over: Partial<Session> = {}): Session => ({
  id: 'sess1',
  batchId: 'b1',
  deviceId: 'dev-other',
  startedAt: 100,
  endedAt: 900,
  status: 'completed',
  segments: [{ index: 0, startedAt: 100, endedAt: 900, currentMa: 1, coulombs: 0.0008, reason: 'start' }],
  marks: [],
  totalCoulombs: 0.0008,
  pausedDurationMs: 0,
  updatedAt: 900,
  ...over,
})

const omit = (o: object, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

const file = (body: Record<string, unknown>) =>
  JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: '2026-10-15T00:00:00.000Z', ...body })

describe('parseBackup', () => {
  it('5 種類を読み、rev を落とす', () => {
    const { items, invalid } = parseBackup(
      file({
        batches: [batch({ rev: 7 })],
        reagents: [reagent()],
        stocks: [stock()],
        pipettes: [pipette()],
        sessions: [session()],
      }),
    )
    expect(invalid).toBe(0)
    expect(items.map((i) => i.kind).sort()).toEqual(['batch', 'pipette', 'reagent', 'session', 'stock'])
    expect(items.every((i) => !('rev' in i.record))).toBe(true)
  })

  it('記録タブの「バッチを JSON で書き出す」（バッチの配列）も読める', () => {
    const { items } = parseBackup(JSON.stringify([batch(), batch({ id: 'b2' })]))
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.kind === 'batch')).toBe(true)
  })

  it('形の合わないレコードは取り込まずに数える（ファイル全体は断らない）', () => {
    const { items, invalid } = parseBackup(
      file({
        batches: [
          batch(),
          batch({ id: 'bad-metal', electrode: { ...batch().electrode, anode: 'Xx' as never } }),
          { ...batch({ id: 'no-computed' }), computed: undefined },
          batch({ id: 'tomb', deletedAt: 5 }),
          'not an object',
        ],
        sessions: [{ ...session(), status: 'exploded' }],
      }),
    )
    expect(items.map((i) => i.record.id)).toEqual(['b1'])
    expect(invalid).toBe(5)
  })

  it('同じ ID が重なったら updatedAt の新しい方', () => {
    const { items } = parseBackup(
      file({ reagents: [reagent({ name: '新', updatedAt: 2000 }), reagent({ name: '旧', updatedAt: 1000 })] }),
    )
    expect(items).toHaveLength(1)
    expect((items[0]!.record as Reagent).name).toBe('新')
  })

  it('古い形（updatedAt・端末 ID・使用記録が無い）は補って読む', () => {
    const oldBatch = omit(batch(), ['updatedAt'])
    const oldStock = omit(stock(), ['updatedAt', 'initialVolumeMl', 'usages'])
    const oldSession = omit(session(), ['deviceId'])
    const { items, invalid } = parseBackup(
      file({ batches: [oldBatch], stocks: [{ ...oldStock, volumeRemainingMl: 40 }], sessions: [oldSession] }),
      5000,
    )
    expect(invalid).toBe(0)
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i.record]))
    expect(byKind.batch!.updatedAt).toBe(Date.parse(batch().createdAt))
    expect(stockRemainingMl(byKind.stock as Stock)).toBe(40)
    expect((byKind.session as Session).deviceId).toBe(IMPORTED_DEVICE_ID)
  })

  it('ファイルとして読めないものは BackupFormatError', () => {
    expect(() => parseBackup('{')).toThrow(BackupFormatError)
    expect(() => parseBackup(JSON.stringify({ hello: 1 }))).toThrow('colloion のバックアップではありません')
    expect(() => parseBackup(file({ version: 2 }))).toThrow('新しい版')
    expect(() => parseBackup(file({ batches: {} }))).toThrow(BackupFormatError)
  })
})

describe('resolveImport', () => {
  it('無ければ追加、同じなら変化なし', () => {
    expect(resolveImport('reagent', undefined, reagent(), 'me').outcome).toBe('added')
    expect(resolveImport('reagent', { ...reagent(), rev: 3 }, reagent(), 'me').outcome).toBe('unchanged')
  })

  it('新しい方が残り、既存の rev を引き継ぐ', () => {
    const newer = resolveImport('reagent', { ...reagent(), rev: 3 }, reagent({ name: '新', updatedAt: 2000 }), 'me')
    expect(newer.outcome).toBe('updated')
    expect(newer.next).toMatchObject({ name: '新', rev: 3 })

    const older = resolveImport('reagent', reagent({ updatedAt: 3000 }), reagent({ name: '旧' }), 'me')
    expect(older.outcome).toBe('unchanged')
  })

  it('この端末で削除済みなら取り込まない', () => {
    const r = resolveImport('batch', batch({ deletedAt: 1500, updatedAt: 1500 }), batch({ updatedAt: 9000 }), 'me')
    expect(r).toEqual({ outcome: 'deletedHere' })
  })

  it('母液の使用記録は和集合（既存の方が新しくても取り込む側の使用を足す）', () => {
    const existing = stock({ updatedAt: 5000, usages: [{ id: 'u2', at: 20, doseMl: 2 }] })
    const incoming = stock({ usages: [{ id: 'u1', at: 10, doseMl: 1 }] })
    const r = resolveImport('stock', existing, incoming, 'me')
    expect(r.outcome).toBe('updated')
    expect((r.next as Stock).usages.map((u) => u.id)).toEqual(['u1', 'u2'])
  })

  it('セッション: 自端末のものは既存が正、他端末のものは新しい方', () => {
    const mine = session({ deviceId: 'me', updatedAt: 100 })
    expect(resolveImport('session', mine, session({ deviceId: 'me', updatedAt: 9000 }), 'me').outcome).toBe(
      'unchanged',
    )
    // 古いバックアップが同期で届いた新しい版を上書きしない
    const synced = session({ updatedAt: 5000, status: 'completed' })
    expect(resolveImport('session', synced, session({ updatedAt: 100, status: 'aborted' }), 'me').outcome).toBe(
      'unchanged',
    )
  })
})

describe('書き出し → 読み込み（IndexedDB）', () => {
  it('別の端末（別オリジン）に全データを移せる', async () => {
    const src = new IndexedDbAdapter('src')
    await src.saveBatch(batch())
    await src.saveBatch(batch({ id: 'gone' }))
    await src.deleteBatch('gone')
    await src.saveReagent(reagent())
    await src.saveStock(stock({ usages: [{ id: 'u1', at: 10, doseMl: 3 }] }))
    await src.savePipette(pipette())
    await src.saveSession(session())

    const backup = await buildBackup(src, new Date('2026-10-15T00:00:00Z'))
    expect(backup.batches.map((b) => b.id)).toEqual(['b1']) // 墓標は書き出さない

    const dst = new IndexedDbAdapter('dst')
    let notified = 0
    dst.onLocalChange(() => notified++)
    const { items, invalid } = parseBackup(JSON.stringify(backup))
    const counts = await dst.importRecords(items)

    expect(invalid).toBe(0)
    expect(counts).toEqual({ added: 5, updated: 0, unchanged: 0, deletedHere: 0 })
    expect(notified).toBe(1)
    expect(await dst.listBatches()).toEqual([batch()])
    expect(await dst.listReagents()).toEqual([reagent()])
    expect(stockRemainingMl((await dst.listStocks())[0]!)).toBe(97)
    expect(await dst.listPipettes()).toEqual([pipette()])
    expect(await dst.listSessions()).toEqual([session()])
    // 取り込んだレコードは同期の送信待ちに積まれる
    expect(await dst.countOutbox()).toBe(5)

    // もう一度読み込んでも何も変わらない
    const again = await dst.importRecords(parseBackup(JSON.stringify(backup)).items)
    expect(again).toEqual({ added: 0, updated: 0, unchanged: 5, deletedHere: 0 })
    expect(notified).toBe(1)
  })

  it('この端末で削除したものは戻らない', async () => {
    const st = new IndexedDbAdapter('del')
    await st.saveBatch(batch())
    const backup = await buildBackup(st)
    await st.deleteBatch('b1')

    const counts = await st.importRecords(parseBackup(JSON.stringify(backup)).items)
    expect(counts.deletedHere).toBe(1)
    expect(await st.listBatches()).toEqual([])
  })
})

describe('MemoryAdapter.importRecords', () => {
  it('IndexedDB 版と同じ規則で取り込む', async () => {
    const st = new MemoryAdapter()
    await st.saveReagent(reagent({ updatedAt: 3000, name: '手元' }))
    const counts = await st.importRecords(
      parseBackup(file({ reagents: [reagent({ name: '古い' })], pipettes: [pipette()] })).items,
    )
    expect(counts).toEqual({ added: 1, updated: 0, unchanged: 1, deletedHere: 0 })
    expect((await st.listReagents())[0]!.name).toBe('手元')
  })
})

it('backupFilename はローカル日付', () => {
  expect(backupFilename(new Date(2026, 9, 5, 23, 59))).toBe('colloion-backup-20261005.json')
})
