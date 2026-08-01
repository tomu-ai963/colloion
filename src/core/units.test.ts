import { describe, expect, it } from 'vitest'
import { clamp, formatDuration, hmToSeconds, parseNonNegative, secondsToHM } from './units'

describe('parseNonNegative — 空文字・負値・NaN で壊れない', () => {
  it('通常の数値', () => {
    expect(parseNonNegative('12.5')).toBe(12.5)
  })
  it('空文字は fallback', () => {
    expect(parseNonNegative('')).toBe(0)
    expect(parseNonNegative('  ', 5)).toBe(5)
  })
  it('NaN / 文字列は fallback', () => {
    expect(parseNonNegative('abc')).toBe(0)
  })
  it('負値は fallback', () => {
    expect(parseNonNegative('-3')).toBe(0)
  })
})

describe('clamp', () => {
  it('範囲内はそのまま、範囲外は丸め', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
  it('NaN は min', () => {
    expect(clamp(NaN, 2, 10)).toBe(2)
  })
})

describe('時間変換', () => {
  it('往復一致', () => {
    expect(hmToSeconds(3, 0)).toBe(10800)
    expect(secondsToHM(10800)).toEqual({ hours: 3, minutes: 0 })
  })
  it('formatDuration', () => {
    expect(formatDuration(4 * 3600 + 58 * 60)).toBe('4 時間 58 分')
    expect(formatDuration(35 * 60)).toBe('35 分')
  })
})
