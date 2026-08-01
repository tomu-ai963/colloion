import { describe, expect, it } from 'vitest'
import { METALS, METAL_SYMBOLS, defaultEta, electrochemicalEquivalent } from './metals'

describe('electrochemicalEquivalent — M/(nF) からの導出', () => {
  // 参考値: モック UI に記載の mg/C
  it.each([
    ['Ag', 1.118],
    ['Au', 0.6805],
    ['Cu', 0.329],
    ['Zn', 0.339],
    ['Mg', 0.126],
    ['Fe', 0.289],
    ['Mn', 0.285],
  ] as const)('%s ≈ %f mg/C', (symbol, expected) => {
    expect(electrochemicalEquivalent(METALS[symbol])).toBeCloseTo(expected, 3)
  })

  it('電解不可（Ca）と不溶性（Pt）は 0', () => {
    expect(electrochemicalEquivalent(METALS.Ca)).toBe(0)
    expect(electrochemicalEquivalent(METALS.Pt)).toBe(0)
  })
})

describe('金属マスタの重要挙動', () => {
  it('Mg はファラデー則不成立・効率レンジ 130–200%・酸溶解を推奨', () => {
    const mg = METALS.Mg
    expect(mg.faradayValid).toBe(false)
    expect(mg.etaRange).toEqual([130, 200])
    expect(mg.recommendedRoute).toBe('acid')
  })

  it('Ca は電解不可で酸溶解を推奨', () => {
    expect(METALS.Ca.electrolyzable).toBe(false)
    expect(METALS.Ca.recommendedRoute).toBe('acid')
  })

  it('Zn の水酸化物析出 pH は 7.0、advisory に再溶解の言及がある', () => {
    expect(METALS.Zn.hydroxidePh).toBe(7.0)
    expect(METALS.Zn.advisory).toContain('pH 11')
  })

  it('Fe / Mn の advisory は空気酸化に触れている', () => {
    expect(METALS.Fe.advisory).toContain('酸化')
    expect(METALS.Mn.advisory).toContain('酸化')
  })

  it('全金属が必須フィールドを持つ', () => {
    for (const s of METAL_SYMBOLS) {
      const m = METALS[s]
      expect(m.atomicWeight).toBeGreaterThan(0)
      expect(m.nameJa.length).toBeGreaterThan(0)
      expect(m.advisory.length).toBeGreaterThan(0)
      expect(m.etaRange[0]).toBeLessThanOrEqual(m.etaRange[1])
    }
  })

  it('defaultEta はレンジ中央、レンジなしは 100', () => {
    expect(defaultEta(METALS.Ag)).toBe(92)
    expect(defaultEta(METALS.Pt)).toBe(100)
    expect(defaultEta(METALS.Mg)).toBe(165)
  })
})
