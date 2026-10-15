import { describe, expect, it } from 'vitest'
import { CORN_SYRUP_MG_PER_MMOL, CORN_SYRUP_NAME, REDUCERS } from './derive'

describe('コーンシロップ（Karo ライト）', () => {
  it('ブドウ糖換算の見かけの分子量は 180.16 ÷（固形分 0.755 × DE 0.42）', () => {
    expect(CORN_SYRUP_MG_PER_MMOL).toBeCloseTo(180.16 / (0.755 * 0.42), 0)
    expect(CORN_SYRUP_MG_PER_MMOL).toBeCloseTo(568, 0)
    expect(REDUCERS[CORN_SYRUP_NAME]).toEqual({ formula: null, mw: CORN_SYRUP_MG_PER_MMOL })
  })

  it('シロップ 1 g は還元糖（ブドウ糖換算）約 1.76 mmol', () => {
    expect(1000 / CORN_SYRUP_MG_PER_MMOL).toBeCloseTo(1.76, 2)
  })
})
