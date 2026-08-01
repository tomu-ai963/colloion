import { describe, expect, it } from 'vitest'
import { dropVolume, finalConcentration, requiredDrops, stockMolarity } from './stock'
import { molecularWeight } from './formula'

const MW_NA2CO3 = molecularWeight('Na2CO3') // 105.99

describe('母液・滴下の回帰ケース（仕様 3.4）', () => {
  // 炭酸ナトリウム 10.6 g / 精製水 100 mL → 1.000 mol/L
  // その 5 滴（20滴=1.00mL キャリブレーション）を 250 mL へ → 1.00 mmol/L
  it('10.6 g / 100 mL → 1.000 mol/L', () => {
    expect(stockMolarity(10.6, 100, MW_NA2CO3, 100)).toBeCloseTo(1.0, 3)
  })

  it('5 滴を 250 mL へ → 1.00 mmol/L', () => {
    const molarity = stockMolarity(10.6, 100, MW_NA2CO3, 100)
    const drop = dropVolume(1.0) // 20滴 = 1.00 mL → 0.05 mL/滴
    expect(drop).toBeCloseTo(0.05, 6)
    const final = finalConcentration(molarity, MW_NA2CO3, 5 * drop, 250)
    expect(final.mmolPerL).toBeCloseTo(1.0, 2)
    expect(final.mg).toBeCloseTo(26.5, 1)
    expect(final.ppm).toBeCloseTo(106, 0)
  })
})

describe('含量（純度）の反映', () => {
  it('含量 99.5% は実質量に掛かる', () => {
    const pure = stockMolarity(10.6, 100, MW_NA2CO3, 100)
    const graded = stockMolarity(10.6, 99.5, MW_NA2CO3, 100)
    expect(graded).toBeCloseTo(pure * 0.995, 9)
  })
})

describe('requiredDrops — 水量が変わっても目標 mmol/L を保つ', () => {
  const molarity = stockMolarity(10.6, 100, MW_NA2CO3, 100) // 1.0 mol/L
  const drop = dropVolume(1.0)

  it('250 mL で 1.00 mmol/L → 5 滴', () => {
    expect(requiredDrops(1.0, molarity, drop, 250)).toBeCloseTo(5, 1)
  })

  it('1000 mL で 1.00 mmol/L → 20 滴', () => {
    expect(requiredDrops(1.0, molarity, drop, 1000)).toBeCloseTo(20, 1)
  })

  it('逆算した滴数で finalConcentration すると目標に戻る（往復一致）', () => {
    const drops = requiredDrops(1.0, molarity, drop, 730)!
    const final = finalConcentration(molarity, MW_NA2CO3, drops * drop, 730)
    expect(final.mmolPerL).toBeCloseTo(1.0, 9)
  })

  it('母液未調製（濃度 0）は null', () => {
    expect(requiredDrops(1.0, 0, drop, 250)).toBeNull()
  })
})

describe('スポイトのキャリブレーション', () => {
  it('20 滴の実測値から 1 滴を補正する', () => {
    expect(dropVolume(0.6)).toBeCloseTo(0.03, 6)
    expect(dropVolume(1.2)).toBeCloseTo(0.06, 6)
  })
  it('負値・NaN は 0', () => {
    expect(dropVolume(-1)).toBe(0)
    expect(dropVolume(NaN)).toBe(0)
  })
})
