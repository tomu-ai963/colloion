import { describe, expect, it } from 'vitest'
import type { Batch } from '../core/model'
import { stockRemainingMl } from '../core/stock'
import { migrateBatch, migratePipette, migrateReagent, migrateSession, migrateStock } from './migrate'

const NOW = 1_760_000_000_000

describe('IndexedDB v2 → v3 のレコード移行', () => {
  it('Batch: updatedAt を createdAt から補完', () => {
    const b = { id: 'b', createdAt: '2026-08-01T10:00:00.000Z' } as Omit<Batch, 'updatedAt'>
    expect(migrateBatch(b, NOW).updatedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
  })

  it('Batch: createdAt が壊れていたら移行時刻', () => {
    const b = { id: 'b', createdAt: 'broken' } as Omit<Batch, 'updatedAt'>
    expect(migrateBatch(b, NOW).updatedAt).toBe(NOW)
  })

  it('既に updatedAt があるレコードは触らない（再実行しても同じ）', () => {
    const b = { id: 'b', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: 42 } as Batch
    expect(migrateBatch(b, NOW).updatedAt).toBe(42)
  })

  it('Reagent: シードは 0、ユーザー登録は移行時刻', () => {
    const base = { name: 'x', formula: 'NaCl', mw: 58.44, purityPct: 100, role: '電解質' as const }
    expect(migrateReagent({ ...base, id: 'seed-nacl' }, NOW).updatedAt).toBe(0)
    expect(migrateReagent({ ...base, id: 'user-1' }, NOW).updatedAt).toBe(NOW)
  })

  it('Pipette: 移行時刻', () => {
    expect(migratePipette({ id: 'p', name: 'p', mlPer20Drops: 1 }, NOW).updatedAt).toBe(NOW)
  })

  it('Stock: 旧残量を調製量に引き継ぎ、表示上の残量は変わらない', () => {
    const legacy = {
      id: 's',
      reagentId: 'r',
      molarity: 1,
      preparedAt: '2026-08-01T10:00:00.000Z',
      volumeRemainingMl: 73.5,
    }
    const m = migrateStock(legacy, NOW)
    expect(m.initialVolumeMl).toBe(73.5)
    expect(m.usages).toEqual([])
    expect(stockRemainingMl(m)).toBe(73.5)
    expect('volumeRemainingMl' in m).toBe(false)
    expect(m.updatedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
  })

  it('Session: 旧セッションはこの端末のもの', () => {
    const s = {
      id: 's',
      batchId: 'b',
      startedAt: 1,
      status: 'completed' as const,
      segments: [],
      marks: [],
      totalCoulombs: 0,
      pausedDurationMs: 0,
      updatedAt: 1,
    }
    expect(migrateSession(s, 'dev-1').deviceId).toBe('dev-1')
    expect(migrateSession({ ...s, deviceId: 'dev-0' }, 'dev-1').deviceId).toBe('dev-0')
  })
})
