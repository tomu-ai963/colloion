import { describe, expect, it } from 'vitest'
import { deepEqual } from './equal'

describe('deepEqual', () => {
  it('キーの順序を問わない', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
  })
  it('undefined のキーは無いものとみなす', () => {
    expect(deepEqual({ a: 1, rev: undefined }, { a: 1 })).toBe(true)
  })
  it('配列の順序・長さ・型の違いを区別する', () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual([1], [1, 1])).toBe(false)
    expect(deepEqual({ 0: 1 }, [1])).toBe(false)
    expect(deepEqual({ a: null }, { a: {} })).toBe(false)
  })
  it('NaN 同士は等しい', () => {
    expect(deepEqual({ v: Number.NaN }, { v: Number.NaN })).toBe(true)
  })
})
