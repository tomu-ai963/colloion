import { describe, expect, it } from 'vitest'
import type { Batch } from '../core/model'
import { MemoryAdapter } from './memoryAdapter'
import { seedReagents } from './seed'
import { batchLabel } from '../store/appStore'

const sampleBatch = (id: string, label: string): Batch => ({
  id,
  label,
  createdAt: new Date('2026-08-01T10:00:00Z').toISOString(),
  updatedAt: 0,
  mode: 'colloid',
  water: { volumeMl: 1000, type: '蒸留水', initialTds: 1, tempC: 24 },
  electrode: { anode: 'Ag', cathode: '銀 Ag', purity: '99.99%', areaCm2: 12, gapMm: 35, route: 'electrolysis' },
  additives: [],
  power: { mode: 'CC', currentMa: 1, voltageV: 24, durationSec: 10800, eta: 92, reversalMin: 15 },
  computed: { mg: 11.1, ppm: 11.1, coulombs: 10.8, currentDensity: 0.08 },
})

describe('StorageAdapter (メモリ実装)', () => {
  it('バッチの保存・一覧・削除', async () => {
    const st = new MemoryAdapter()
    await st.saveBatch(sampleBatch('a', '2026-0801-01'))
    await st.saveBatch(sampleBatch('b', '2026-0801-02'))
    expect(await st.listBatches()).toHaveLength(2)
    await st.deleteBatch('a')
    expect((await st.listBatches()).map((b) => b.id)).toEqual(['b'])
  })

  it('削除は墓標を書き、一覧から消える（物理削除しない）', async () => {
    const st = new MemoryAdapter()
    await st.saveBatch(sampleBatch('a', '2026-0801-01'))
    await st.deleteBatch('a')
    expect(await st.listBatches()).toHaveLength(0)
    // 墓標付きで上書き保存されたレコードは同期で他端末に削除を伝える材料になる
    await st.deleteBatch('missing') // 存在しない ID は何もしない
    expect(await st.listBatches()).toHaveLength(0)
  })

  it('端末 ID は同じアダプタで常に同じ値', async () => {
    const st = new MemoryAdapter()
    const a = await st.getDeviceId()
    expect(a).toBeTruthy()
    expect(await st.getDeviceId()).toBe(a)
  })

  it('result の追記が保存される（computed は保存時点のまま）', async () => {
    const st = new MemoryAdapter()
    const b = sampleBatch('a', '2026-0801-01')
    await st.saveBatch(b)
    await st.saveBatch({ ...b, result: { measuredTds: 9, verdict: '良' } })
    const [loaded] = await st.listBatches()
    expect(loaded!.result?.measuredTds).toBe(9)
    expect(loaded!.computed.ppm).toBe(11.1)
  })

  it('シード試薬の分子量はパーサー由来', () => {
    const seeds = seedReagents()
    const citrate = seeds.find((r) => r.name.includes('クエン酸'))!
    expect(Math.abs(citrate.mw - 294.1)).toBeLessThanOrEqual(0.01)
  })
})

describe('batchLabel', () => {
  it('同日の既存バッチ数から連番を振る', () => {
    const now = new Date(2026, 7, 1) // 2026-08-01
    expect(batchLabel([], now)).toBe('2026-0801-01')
    const existing = [
      { label: '2026-0801-01' },
      { label: '2026-0801-02' },
      { label: '2026-0731-05' },
    ] as Batch[]
    expect(batchLabel(existing, now)).toBe('2026-0801-03')
  })
})
