import { describe, expect, it } from 'vitest'
import { mergeBatch, mergeLww, mergeRecord, mergeSession, mergeStock, unionUsages } from './merge'
import type { Batch, Reagent, Stock } from './model'
import { createSession } from './session'

const T = 1_750_000_000_000

const reagent = (patch: Partial<Reagent>): Reagent => ({
  id: 'r1',
  name: '炭酸ナトリウム',
  formula: 'Na2CO3',
  mw: 105.99,
  purityPct: 100,
  role: '電解質',
  updatedAt: T,
  ...patch,
})

const batch = (patch: Partial<Batch>): Batch => ({
  id: 'b1',
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

const stock = (patch: Partial<Stock>): Stock => ({
  id: 's1',
  reagentId: 'r1',
  molarity: 1,
  preparedAt: new Date(T).toISOString(),
  initialVolumeMl: 100,
  usages: [],
  updatedAt: T,
  ...patch,
})

describe('mergeLww — 後勝ち', () => {
  it('updatedAt が新しい方が残る', () => {
    const local = reagent({ name: 'ローカル', updatedAt: T + 10 })
    const remote = reagent({ name: 'リモート', updatedAt: T + 5 })
    expect(mergeLww(local, remote).name).toBe('ローカル')
    expect(mergeLww(remote, local).name).toBe('ローカル')
  })

  it('同時刻ならサーバー側（remote）', () => {
    expect(mergeLww(reagent({ name: 'L' }), reagent({ name: 'R' })).name).toBe('R')
  })

  it('墓標は後からの編集より強い', () => {
    const deleted = reagent({ deletedAt: T + 1, updatedAt: T + 1 })
    const edited = reagent({ name: '編集', updatedAt: T + 100 })
    expect(mergeLww(deleted, edited).deletedAt).toBe(T + 1)
    expect(mergeLww(edited, deleted).deletedAt).toBe(T + 1)
  })

  it('rev は大きい方を引き継ぐ（勝敗と無関係に）', () => {
    const local = reagent({ updatedAt: T + 10, rev: 3 })
    const remote = reagent({ updatedAt: T, rev: 7 })
    const m = mergeLww(local, remote)
    expect(m.updatedAt).toBe(T + 10)
    expect(m.rev).toBe(7)
  })

  it('両方未同期なら rev は付かない', () => {
    expect('rev' in mergeLww(reagent({}), reagent({}))).toBe(false)
  })
})

describe('mergeBatch', () => {
  const measured = { coulombs: 5.4, mg: 5.5, ppm: 5.5, etaPct: 92, sessionId: 'sess' }

  it('result は後勝ち', () => {
    const local = batch({ result: { verdict: '良' }, updatedAt: T + 20 })
    const remote = batch({ result: { verdict: '凝集' }, updatedAt: T + 10 })
    expect(mergeBatch(local, remote).result?.verdict).toBe('良')
  })

  it('負けた側にしか無い measured を消さない', () => {
    // 端末 A が通電を終えて measured を書き、端末 B が後から result を書いた
    const a = batch({ measured, updatedAt: T + 10 })
    const b = batch({ result: { measuredTds: 9 }, updatedAt: T + 20 })
    const m = mergeBatch(a, b)
    expect(m.result?.measuredTds).toBe(9)
    expect(m.measured).toEqual(measured)
  })

  it('computed は保存時点のまま（どちらが勝っても同じ値）', () => {
    const m = mergeBatch(batch({ updatedAt: T + 1 }), batch({ updatedAt: T + 2 }))
    expect(m.computed.ppm).toBe(11.1)
  })

  it('削除が勝ったら measured を拾わない', () => {
    const m = mergeBatch(batch({ measured }), batch({ deletedAt: T + 1, updatedAt: T + 1 }))
    expect(m.deletedAt).toBe(T + 1)
    expect(m.measured).toBeUndefined()
  })
})

describe('mergeStock — 使用記録は和集合', () => {
  it('2 台で別々に使った分が両方残る', () => {
    const base = [{ id: 'u0', at: T, doseMl: 0.25 }]
    const local = stock({ usages: [...base, { id: 'uA', at: T + 10, doseMl: 0.5 }], updatedAt: T + 10 })
    const remote = stock({ usages: [...base, { id: 'uB', at: T + 5, doseMl: 0.3 }], updatedAt: T + 5 })
    const m = mergeStock(local, remote)
    expect(m.usages.map((u) => u.id)).toEqual(['u0', 'uB', 'uA'])
  })

  it('unionUsages は ID で重複除去し時刻順', () => {
    const u = (id: string, at: number) => ({ id, at, doseMl: 1 })
    expect(unionUsages([u('b', 2), u('a', 1)], [u('a', 1), u('c', 2)]).map((x) => x.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})

describe('mergeSession — 書き込めるのは開いた端末だけ', () => {
  const mine = 'device-me'
  const theirs = 'device-other'

  it('自端末のセッションはローカルが正（サーバーの updatedAt が新しくても）', () => {
    const local = { ...createSession('s', 'b', mine, T, 1), updatedAt: T + 1 }
    const remote = { ...createSession('s', 'b', mine, T, 2), updatedAt: T + 999 }
    expect(mergeSession(local, remote, mine).segments[0]!.currentMa).toBe(1)
  })

  it('他端末のセッションはサーバーが正', () => {
    const local = { ...createSession('s', 'b', theirs, T, 1), updatedAt: T + 999 }
    const remote = { ...createSession('s', 'b', theirs, T, 2), updatedAt: T + 1 }
    expect(mergeSession(local, remote, mine).segments[0]!.currentMa).toBe(2)
  })

  it('墓標は所有者に関係なく残る', () => {
    const local = createSession('s', 'b', mine, T, 1)
    const remote = { ...createSession('s', 'b', mine, T, 1), deletedAt: T + 5, updatedAt: T + 5 }
    expect(mergeSession(local, remote, mine).deletedAt).toBe(T + 5)
  })
})

describe('mergeRecord — 種類ごとの振り分け', () => {
  it('stock は和集合の規則が使われる', () => {
    const m = mergeRecord(
      'stock',
      stock({ usages: [{ id: 'a', at: 1, doseMl: 1 }] }),
      stock({ usages: [{ id: 'b', at: 2, doseMl: 1 }] }),
      'me',
    )
    expect(m.usages).toHaveLength(2)
  })

  it('reagent / pipette は後勝ち', () => {
    const m = mergeRecord('reagent', reagent({ name: 'L', updatedAt: T + 1 }), reagent({ name: 'R' }), 'me')
    expect(m.name).toBe('L')
  })
})
