import { describe, expect, it } from 'vitest'
import {
  activeElapsedMs,
  addMark,
  averageCurrentMa,
  chartSeries,
  computeMeasured,
  coulombsAt,
  createSession,
  cutSegment,
  decimate,
  endSession,
  expectedReversals,
  msUntilReversal,
  openSegment,
  pauseSession,
  polarityFlipped,
  recoverAsEnded,
  recoverAsEnergized,
  recoverAsStopped,
  resumeSession,
  reversalCount,
  reversalPositionsMs,
  sessionCoulombs,
  verifyTotalCoulombs,
} from './session'

const T0 = 1_750_000_000_000 // 適当な基準時刻 (epoch ms)
const MIN = 60_000
const HOUR = 3_600_000

describe('時刻ベースの積算（最重要）', () => {
  it('経過 1 時間・tick が 100 回しか呼ばれなくても電荷は正しい', () => {
    const s = createSession('s1', 'b1', T0, 1.0)
    // tick 相当の評価をまばらに 100 回だけ行う（値は使い捨て）
    for (let i = 1; i <= 100; i++) {
      sessionCoulombs(s, T0 + i * 36_000) // 36 秒間隔でしか「描画」されない
    }
    // 最終評価: 1.0 mA × 3600 s = 3.6 C — 呼び出し回数に依存しない
    expect(sessionCoulombs(s, T0 + HOUR)).toBeCloseTo(3.6, 9)
    expect(activeElapsedMs(s, T0 + HOUR)).toBe(HOUR)
  })

  it('スリープ復帰: 30 分評価されなくても差分から正しく再計算される', () => {
    const s = createSession('s1', 'b1', T0, 2.0)
    const beforeSleep = sessionCoulombs(s, T0 + 10 * MIN)
    expect(beforeSleep).toBeCloseTo(1.2, 9) // 2 mA × 600 s
    // 30 分のスリープ後、次の評価で一気に追いつく
    const afterSleep = sessionCoulombs(s, T0 + 40 * MIN)
    expect(afterSleep).toBeCloseTo(4.8, 9) // 2 mA × 2400 s
  })

  it('一時停止中は経過時間・電荷とも進まない', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = pauseSession(s, T0 + 10 * MIN)
    // 停止中に 20 分経過
    expect(sessionCoulombs(s, T0 + 30 * MIN)).toBeCloseTo(0.6, 9) // 1 mA × 600 s のまま
    expect(activeElapsedMs(s, T0 + 30 * MIN)).toBe(10 * MIN)

    s = resumeSession(s, T0 + 30 * MIN)
    expect(s.pausedDurationMs).toBe(20 * MIN)
    expect(s.segments[s.segments.length - 1]!.reason).toBe('resume')
    // 再開から 5 分
    expect(sessionCoulombs(s, T0 + 35 * MIN)).toBeCloseTo(0.9, 9)
    expect(activeElapsedMs(s, T0 + 35 * MIN)).toBe(15 * MIN)
  })

  it('running 以外では cutSegment は何もしない', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = pauseSession(s, T0 + MIN)
    const after = cutSegment(s, T0 + 2 * MIN, 'current_change', { currentMa: 3 })
    expect(after).toBe(s)
  })
})

describe('区間の自動区切り', () => {
  it('電流変更で区間が閉じ、電荷が区間ごとに正しく積算される', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 30 * MIN, 'current_change', { currentMa: 3.0 })

    expect(s.segments).toHaveLength(2)
    const [first, second] = s.segments
    expect(first!.endedAt).toBe(T0 + 30 * MIN)
    expect(first!.coulombs).toBeCloseTo(1.8, 9) // 1 mA × 1800 s
    expect(second!.currentMa).toBe(3.0)
    expect(second!.reason).toBe('current_change')

    // さらに 10 分後: 1.8 + 3 mA × 600 s = 3.6
    expect(sessionCoulombs(s, T0 + 40 * MIN)).toBeCloseTo(1.8 + 1.8, 9)
    expect(s.totalCoulombs).toBeCloseTo(1.8, 9) // 確定分のみ
  })

  it('閉じた区間は後続の操作で書き換わらない（append-only）', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 10 * MIN, 'current_change', { currentMa: 2.0 })
    const closedSnapshot = { ...s.segments[0]! }
    s = cutSegment(s, T0 + 20 * MIN, 'reversal')
    s = pauseSession(s, T0 + 25 * MIN)
    s = resumeSession(s, T0 + 30 * MIN)
    s = endSession(s, T0 + 40 * MIN)
    expect(s.segments[0]).toEqual(closedSnapshot)
  })

  it('電圧だけ変更しても区間が切れ、電流は引き継がれる', () => {
    let s = createSession('s1', 'b1', T0, 1.0, 24)
    s = cutSegment(s, T0 + 5 * MIN, 'voltage_change', { voltageV: 30 })
    const open = openSegment(s)!
    expect(open.currentMa).toBe(1.0)
    expect(open.voltageV).toBe(30)
  })
})

describe('整合性チェック', () => {
  it('正常なセッションは ok', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 10 * MIN, 'reversal')
    s = cutSegment(s, T0 + 20 * MIN, 'reversal')
    expect(verifyTotalCoulombs(s).ok).toBe(true)
  })

  it('totalCoulombs が壊れていたら検出する', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 10 * MIN, 'reversal')
    const broken = { ...s, totalCoulombs: s.totalCoulombs + 1 }
    const check = verifyTotalCoulombs(broken)
    expect(check.ok).toBe(false)
    expect(check.recomputed).toBeCloseTo(0.6, 9)
  })
})

describe('クラッシュ復帰', () => {
  const crashed = () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = { ...s, updatedAt: T0 + 30 * MIN } // 最後の書き込みは 30 分時点
    return s
  }
  const now = T0 + 90 * MIN // 60 分の空白のあと再起動

  it('通電していた扱い → 空白も電荷に含まれる', () => {
    const s = recoverAsEnergized(crashed(), now)
    expect(sessionCoulombs(s, now)).toBeCloseTo(5.4, 9) // 1 mA × 5400 s
  })

  it('止まっていた扱い → 空白は停止時間になり電荷に入らない', () => {
    const s = recoverAsStopped(crashed(), now)
    expect(s.pausedDurationMs).toBe(60 * MIN)
    expect(sessionCoulombs(s, now)).toBeCloseTo(1.8, 9) // 最終書き込みまでの 30 分のみ
    expect(activeElapsedMs(s, now)).toBe(30 * MIN)
    expect(openSegment(s)!.reason).toBe('resume')
  })

  it('終了扱い → endedAt は最終書き込み時刻', () => {
    const s = recoverAsEnded(crashed())
    expect(s.status).toBe('completed')
    expect(s.endedAt).toBe(T0 + 30 * MIN)
    expect(s.totalCoulombs).toBeCloseTo(1.8, 9)
  })
})

describe('極性反転', () => {
  it('期待反転回数は通電経過から出る（停止時間は数えない）', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    expect(expectedReversals(s, T0 + 44 * MIN, 15)).toBe(2)
    s = pauseSession(s, T0 + 10 * MIN)
    s = resumeSession(s, T0 + 40 * MIN) // 30 分停止
    // 実通電 10 分 + 20 分 = 30 分 → 反転 2 回ぶん
    expect(expectedReversals(s, T0 + 60 * MIN, 15)).toBe(2)
  })

  it('反転区間を数え、奇数回で極性が入れ替わる', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    expect(polarityFlipped(s)).toBe(false)
    s = cutSegment(s, T0 + 15 * MIN, 'reversal')
    expect(reversalCount(s)).toBe(1)
    expect(polarityFlipped(s)).toBe(true)
    s = cutSegment(s, T0 + 30 * MIN, 'reversal')
    expect(polarityFlipped(s)).toBe(false)
  })

  it('カウントダウンと反転なし設定', () => {
    const s = createSession('s1', 'b1', T0, 1.0)
    expect(msUntilReversal(s, T0 + 14 * MIN, 15)).toBe(1 * MIN)
    expect(msUntilReversal(s, T0, 0)).toBeNull()
  })

  it('反転位置（グラフマーカー）は通電経過軸で出る', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 15 * MIN, 'reversal')
    s = cutSegment(s, T0 + 30 * MIN, 'reversal')
    expect(reversalPositionsMs(s)).toEqual([15 * MIN, 30 * MIN])
  })
})

describe('派生値', () => {
  it('coulombsAt は任意時点の積算を返す', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 10 * MIN, 'current_change', { currentMa: 2.0 })
    expect(coulombsAt(s, T0 + 5 * MIN)).toBeCloseTo(0.3, 9)
    expect(coulombsAt(s, T0 + 10 * MIN)).toBeCloseTo(0.6, 9)
    expect(coulombsAt(s, T0 + 15 * MIN)).toBeCloseTo(0.6 + 0.6, 9)
  })

  it('平均電流は電荷 / 通電時間', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 10 * MIN, 'current_change', { currentMa: 3.0 })
    // 10 分 @1mA + 10 分 @3mA → 平均 2 mA
    expect(averageCurrentMa(s, T0 + 20 * MIN)).toBeCloseTo(2.0, 9)
  })

  it('computeMeasured: 積算電荷 → mg / ppm', () => {
    const s = createSession('s1', 'b1', T0, 1.0)
    const m = computeMeasured(s, T0 + HOUR, 1.118, 92, 1000)
    expect(m.coulombs).toBeCloseTo(3.6, 9)
    expect(m.mg).toBeCloseTo(1.118 * 3.6 * 0.92, 9)
    expect(m.ppm).toBeCloseTo(m.mg, 9)
  })

  it('endSession 後は時間が固定される', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = endSession(s, T0 + HOUR)
    expect(sessionCoulombs(s, T0 + 2 * HOUR)).toBeCloseTo(3.6, 9)
    expect(activeElapsedMs(s, T0 + 2 * HOUR)).toBe(HOUR)
  })

  it('マークは追記され updatedAt が進む', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = addMark(s, { at: T0 + MIN, kind: 'temp', value: 26.4 })
    expect(s.marks).toHaveLength(1)
    expect(s.updatedAt).toBe(T0 + MIN)
  })
})

describe('グラフ系列', () => {
  it('区間の始点・終点から折れ線を作る（全秒サンプルはしない）', () => {
    let s = createSession('s1', 'b1', T0, 1.0)
    s = cutSegment(s, T0 + 10 * MIN, 'current_change', { currentMa: 2.0 })
    const pts = chartSeries(s, T0 + 20 * MIN)
    expect(pts.length).toBe(4) // 2 区間 × 2 点
    expect(pts[0]).toMatchObject({ elapsedMs: 0, ppmCoulombs: 0, currentMa: 1.0 })
    expect(pts[1]!.ppmCoulombs).toBeCloseTo(0.6, 9)
    expect(pts[3]!.ppmCoulombs).toBeCloseTo(1.8, 9)
  })

  it('decimate は先頭・末尾を残して maxPoints に間引く', () => {
    const arr = Array.from({ length: 10800 }, (_, i) => i)
    const out = decimate(arr, 240)
    expect(out.length).toBe(240)
    expect(out[0]).toBe(0)
    expect(out[out.length - 1]).toBe(10799)
    expect(decimate([1, 2, 3], 240)).toEqual([1, 2, 3])
  })
})
