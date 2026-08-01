import { describe, expect, it } from 'vitest'
import {
  computeElectrolysis,
  concentrationPpm,
  coulombs,
  currentDensity,
  depositedMg,
  requiredDurationSec,
} from './faraday'
import { METALS, electrochemicalEquivalent } from './metals'

const AG_EQ = electrochemicalEquivalent(METALS.Ag) // ≈ 1.118 mg/C

describe('順算', () => {
  it('1.0 mA × 3 時間 × η92% / 1 L（銀）≈ 11.1 ppm', () => {
    const r = computeElectrolysis({
      equivalentMgPerC: AG_EQ,
      currentMa: 1.0,
      durationSec: 3 * 3600,
      etaPct: 92,
      volumeMl: 1000,
    })
    expect(r.coulombs).toBeCloseTo(10.8, 3)
    expect(r.mg).toBeCloseTo(AG_EQ * 10.8 * 0.92, 6)
    expect(r.ppm).toBeCloseTo(r.mg, 6) // 1 L なので mg = ppm
  })

  it('水量 0 では ppm 0（NaN / Infinity を出さない）', () => {
    expect(concentrationPpm(10, 0)).toBe(0)
  })

  it('負値・NaN は 0 として扱う', () => {
    expect(coulombs(-5, 3600)).toBe(0)
    expect(coulombs(NaN, 3600)).toBe(0)
    expect(depositedMg(1.118, -10, 92)).toBe(0)
  })
})

describe('逆算と往復一致', () => {
  it('順算 → 逆算で時間が一致する', () => {
    const params = { equivalentMgPerC: AG_EQ, currentMa: 1.0, etaPct: 92, volumeMl: 1000 }
    const durationSec = 3 * 3600
    const { ppm } = computeElectrolysis({ ...params, durationSec })
    expect(requiredDurationSec(ppm, params)).toBeCloseTo(durationSec, 6)
  })

  it('逆算 → 順算で ppm が一致する', () => {
    const params = { equivalentMgPerC: AG_EQ, currentMa: 2.5, etaPct: 88, volumeMl: 500 }
    const sec = requiredDurationSec(20, params)
    expect(sec).not.toBeNull()
    const { ppm } = computeElectrolysis({ ...params, durationSec: sec! })
    expect(ppm).toBeCloseTo(20, 9)
  })

  it('不溶性電極（当量 0）は null（Infinity を返さない）', () => {
    const eq = electrochemicalEquivalent(METALS.Pt)
    expect(requiredDurationSec(20, { equivalentMgPerC: eq, currentMa: 1, etaPct: 92, volumeMl: 1000 })).toBeNull()
  })

  it('電解不可（Ca）も null', () => {
    const eq = electrochemicalEquivalent(METALS.Ca)
    expect(requiredDurationSec(20, { equivalentMgPerC: eq, currentMa: 1, etaPct: 92, volumeMl: 1000 })).toBeNull()
  })

  it('電流 0・効率 0 も null', () => {
    expect(requiredDurationSec(20, { equivalentMgPerC: AG_EQ, currentMa: 0, etaPct: 92, volumeMl: 1000 })).toBeNull()
    expect(requiredDurationSec(20, { equivalentMgPerC: AG_EQ, currentMa: 1, etaPct: 0, volumeMl: 1000 })).toBeNull()
  })
})

describe('電流密度', () => {
  it('1.0 mA / 12 cm² ≈ 0.083 mA/cm²', () => {
    expect(currentDensity(1.0, 12)).toBeCloseTo(0.0833, 3)
  })
  it('面積 0 は 0', () => {
    expect(currentDensity(1.0, 0)).toBe(0)
  })
})
