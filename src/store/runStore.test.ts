import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Batch } from '../core/model'
import { createSession } from '../core/session'
import { getStorage } from '../storage'
import { useAppStore } from './appStore'
import { useRunStore } from './runStore'

const T0 = 1_750_000_000_000
const MIN = 60_000

const makeBatch = (id = 'batch-1'): Batch => ({
  id,
  label: '2026-0801-01',
  createdAt: new Date(T0).toISOString(),
  updatedAt: 0,
  mode: 'colloid',
  water: { volumeMl: 1000, type: '蒸留水', initialTds: 1, tempC: 24 },
  electrode: { anode: 'Ag', cathode: '銀 Ag', purity: '99.99%', areaCm2: 12, gapMm: 35, route: 'electrolysis' },
  additives: [],
  power: { mode: 'CC', currentMa: 1.0, voltageV: 24, durationSec: 10800, eta: 92, reversalMin: 15 },
  computed: { mg: 11.1, ppm: 11.1, coulombs: 10.8, currentDensity: 0.083 },
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  useRunStore.setState({ session: null, batch: null, recovery: null, integrityWarning: null })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runStore: 開始 → 区間切り → 終了 → measured 書き戻し', () => {
  it('終了時に Batch.measured が書き込まれ computed は不変のまま', async () => {
    const batch = makeBatch('rb-1')
    await getStorage().saveBatch(batch)
    useAppStore.setState({ batches: [batch] })

    await useRunStore.getState().start(batch)
    expect(useRunStore.getState().session?.status).toBe('running')

    // 30 分 @1.0mA → 電流を 2.0mA に変更
    vi.setSystemTime(T0 + 30 * MIN)
    await useRunStore.getState().changeSettings(2.0, 24)
    const s1 = useRunStore.getState().session!
    expect(s1.segments.filter((g) => g.endedAt !== undefined)).toHaveLength(1)

    // さらに 30 分 @2.0mA → 終了
    vi.setSystemTime(T0 + 60 * MIN)
    const ppm = await useRunStore.getState().end()

    // 電荷 = 1mA×1800s + 2mA×1800s = 1.8 + 3.6 = 5.4 C
    // mg = 1.11797 × 5.4 × 0.92 ≈ 5.554 → 1L なので ppm も同じ
    expect(ppm).not.toBeNull()
    expect(ppm!).toBeCloseTo(1.11797 * 5.4 * 0.92, 2)

    const updated = useAppStore.getState().batches.find((b) => b.id === 'rb-1')!
    expect(updated.measured).toBeDefined()
    expect(updated.measured!.coulombs).toBeCloseTo(5.4, 6)
    expect(updated.measured!.sessionId).toBeTruthy()
    // computed は保存時点のまま
    expect(updated.computed.ppm).toBe(11.1)
    // 永続化も確認
    const stored = (await getStorage().listBatches()).find((b) => b.id === 'rb-1')!
    expect(stored.measured!.coulombs).toBeCloseTo(5.4, 6)
    // セッションは completed で保存されている
    const sessions = await getStorage().listSessions()
    expect(sessions.find((s) => s.batchId === 'rb-1')!.status).toBe('completed')
  })

  it('tick で反転時刻を検知して区間を切る（時刻ベース・自己修復）', async () => {
    const batch = makeBatch('rb-2')
    await getStorage().saveBatch(batch)
    useAppStore.setState({ batches: [batch] })
    await useRunStore.getState().start(batch)

    // 16 分後に初めて tick（スリープしていた想定）→ 15 分の反転を検知
    vi.setSystemTime(T0 + 16 * MIN)
    useRunStore.getState().tick()
    const s = useRunStore.getState().session!
    expect(s.segments.filter((g) => g.reason === 'reversal')).toHaveLength(1)
    expect(useRunStore.getState().reversalNoticeAt).not.toBeNull()
    await useRunStore.getState().end(true)
  })
})

describe('runStore: クラッシュ復帰', () => {
  it('running セッションが残っていたら recovery が立つ', async () => {
    const batch = makeBatch('rb-3')
    await getStorage().saveBatch(batch)
    useAppStore.setState({ batches: [batch] })
    await useRunStore.getState().start(batch)
    // クラッシュを模す: ストアだけ空にする（IndexedDB には running のまま残る）
    useRunStore.setState({ session: null, batch: null })

    await useRunStore.getState().checkRecovery()
    const rec = useRunStore.getState().recovery
    expect(rec).not.toBeNull()
    expect(rec!.batch?.id).toBe('rb-3')

    // 「ここで終了として記録」→ 最終書き込み時刻で completed になり measured が書かれる
    await useRunStore.getState().applyRecovery('ended')
    expect(useRunStore.getState().recovery).toBeNull()
    const sessions = await getStorage().listSessions()
    expect(sessions.find((s) => s.batchId === 'rb-3')!.status).toBe('completed')
    const updated = useAppStore.getState().batches.find((b) => b.id === 'rb-3')!
    expect(updated.measured).toBeDefined()
  })

  it('同期で届いた他端末の通電中セッションには復帰ダイアログを出さない', async () => {
    const batch = makeBatch('rb-5')
    await getStorage().saveBatch(batch)
    useAppStore.setState({ batches: [batch] })
    await getStorage().saveSession(createSession('other-s', 'rb-5', 'other-device', T0, 1.0))

    await useRunStore.getState().checkRecovery()
    expect(useRunStore.getState().recovery).toBeNull()
  })

  it('「止まっていた扱い」で復帰すると空白が電荷に入らない', async () => {
    const batch = makeBatch('rb-4')
    await getStorage().saveBatch(batch)
    useAppStore.setState({ batches: [batch] })
    await useRunStore.getState().start(batch)
    useRunStore.setState({ session: null, batch: null })

    // 40 分後に再起動
    vi.setSystemTime(T0 + 40 * MIN)
    await useRunStore.getState().checkRecovery()
    await useRunStore.getState().applyRecovery('stopped')

    const s = useRunStore.getState().session!
    expect(s.status).toBe('running')
    // 最終書き込み（開始直後）以降は停止扱い → 電荷はほぼ 0
    vi.setSystemTime(T0 + 41 * MIN)
    const ppm = await useRunStore.getState().end()
    expect(ppm).not.toBeNull()
    const updated = useAppStore.getState().batches.find((b) => b.id === 'rb-4')!
    expect(updated.measured!.coulombs).toBeLessThan(0.1) // 40 分通電なら 2.4 C になるはず
  })
})
