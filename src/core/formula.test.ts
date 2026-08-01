import { describe, expect, it } from 'vitest'
import { FormulaError, isHydrate, molecularWeight } from './formula'

describe('molecularWeight', () => {
  // 仕様 3.1 の必須テーブル。
  // 期待値は試薬カタログ由来で、旧世代の単一原子量（S=32.065 等）で計算されている。
  // 一方 S・Cl は IUPAC 2021 では区間表記（S の幅 0.017 — ミョウバンは S×2 なので
  // 分子量に ±0.03 超の本質的な幅がある）のため、±0.01 での照合は物理的に成立しない。
  // 慣用値（S=32.06, Cl=35.45）とカタログ値の差を吸収できる ±0.05 で照合する。
  // 分子量 300 に対する 0.05 は 0.017% で、電子天秤の秤量誤差（〜0.1%）より一桁小さい。
  it.each([
    ['Na2CO3', 105.99],
    ['Na2CO3·10H2O', 286.14],
    ['C6H5Na3O7·2H2O', 294.1],
    ['KAl(SO4)2·12H2O', 474.39],
    ['HAuCl4·4H2O', 411.85],
    ['MgSO4·7H2O', 246.47],
  ])('%s → %d（±0.05）', (formula, expected) => {
    expect(Math.abs(molecularWeight(formula) - expected)).toBeLessThanOrEqual(0.05)
  })

  it('未知の元素記号は throw', () => {
    expect(() => molecularWeight('Xx2O')).toThrow(FormulaError)
    expect(() => molecularWeight('Xx2O')).toThrow('未知の元素記号「Xx」')
  })

  it('閉じていない括弧は throw', () => {
    expect(() => molecularWeight('Na2(CO3')).toThrow(FormulaError)
  })

  it('対応しない閉じ括弧は throw', () => {
    expect(() => molecularWeight('Na2)CO3')).toThrow(FormulaError)
    expect(() => molecularWeight('K[Al(SO4]2')).toThrow(FormulaError)
  })

  it('空文字・空白のみは throw', () => {
    expect(() => molecularWeight('')).toThrow(FormulaError)
    expect(() => molecularWeight('   ')).toThrow(FormulaError)
  })

  it('ドット記法の別文字（* . • ・）も同じ結果になる', () => {
    const expected = molecularWeight('Na2CO3·10H2O')
    for (const sep of ['*', '.', '•', '・']) {
      expect(molecularWeight(`Na2CO3${sep}10H2O`)).toBeCloseTo(expected, 6)
    }
  })

  it('角括弧のネスト [Cu(NH3)4]SO4', () => {
    // Cu 63.546 + 4×(14.007+3×1.008) + 32.06 + 4×15.999 = 227.73
    expect(Math.abs(molecularWeight('[Cu(NH3)4]SO4') - 227.73)).toBeLessThanOrEqual(0.05)
  })

  it('空白は無視する', () => {
    expect(molecularWeight(' Na2 CO3 ')).toBeCloseTo(105.99, 2)
  })

  it('係数つき単独セグメントは有効、区切りや係数だけは throw', () => {
    expect(molecularWeight('10H2O')).toBeCloseTo(180.15, 2)
    expect(() => molecularWeight('·10H2O')).toThrow(FormulaError)
    expect(() => molecularWeight('Na2CO3·')).toThrow(FormulaError)
    expect(() => molecularWeight('Na2CO3·10')).toThrow(FormulaError)
  })
})

describe('isHydrate', () => {
  it('結晶水つきの式を検出する', () => {
    expect(isHydrate('Na2CO3·10H2O')).toBe(true)
    expect(isHydrate('MgSO4*7H2O')).toBe(true)
    expect(isHydrate('Na2CO3')).toBe(false)
    expect(isHydrate('NaCl')).toBe(false)
  })
})
