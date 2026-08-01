/** min 以上 max 以下に丸める。NaN は min に落とす */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 入力文字列 → 数値。空文字・NaN・負値は fallback（既定 0）に落とす */
export function parseNonNegative(raw: string, fallback = 0): number {
  if (raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

export function mlToL(ml: number): number {
  return ml / 1000
}

export function hmToSeconds(hours: number, minutes: number): number {
  return Math.max(0, hours) * 3600 + Math.max(0, minutes) * 60
}

export function secondsToHM(sec: number): { hours: number; minutes: number } {
  const s = Math.max(0, Math.round(sec))
  return { hours: Math.floor(s / 3600), minutes: Math.round((s % 3600) / 60) }
}

/** 「4 時間 58 分」形式。1 時間未満は「58 分」 */
export function formatDuration(sec: number): string {
  const { hours, minutes } = secondsToHM(sec)
  return hours > 0 ? `${hours} 時間 ${minutes} 分` : `${minutes} 分`
}
