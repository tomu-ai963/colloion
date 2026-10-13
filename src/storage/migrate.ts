import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'

/**
 * IndexedDB v2 → v3 のレコード移行（同期メタ情報の補完）。純関数。
 * v2 以前のレコードには updatedAt / deviceId が無く、Stock は残量を直接持っていた。
 */

type Legacy<T> = Omit<T, 'updatedAt'> & { updatedAt?: number }

export type LegacyStock = Omit<Stock, 'updatedAt' | 'initialVolumeMl' | 'usages'> & {
  updatedAt?: number
  initialVolumeMl?: number
  usages?: Stock['usages']
  /** v2 の残量。v3 では initialVolumeMl − usages で求める */
  volumeRemainingMl?: number
}

const parseTime = (iso: string, fallback: number): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : fallback
}

export function migrateBatch(b: Legacy<Batch>, nowMs: number): Batch {
  return { ...b, updatedAt: b.updatedAt ?? parseTime(b.createdAt, nowMs) }
}

/**
 * シード試薬は全端末で同じ ID・同じ内容なので updatedAt = 0（どの実データにも負ける）。
 * ユーザー登録の試薬は作成時刻が残っていないので移行時刻を入れる。
 */
export function migrateReagent(r: Legacy<Reagent>, nowMs: number): Reagent {
  return { ...r, updatedAt: r.updatedAt ?? (r.id.startsWith('seed-') ? 0 : nowMs) }
}

export function migratePipette(p: Legacy<Pipette>, nowMs: number): Pipette {
  return { ...p, updatedAt: p.updatedAt ?? nowMs }
}

/**
 * v2 の残量を v3 の調製量として引き継ぐ（それまでの使用履歴は v2 に残っていないため）。
 * 表示される残量は移行前と変わらない。
 */
export function migrateStock(s: LegacyStock, nowMs: number): Stock {
  const { volumeRemainingMl, ...rest } = s
  return {
    ...rest,
    initialVolumeMl: s.initialVolumeMl ?? volumeRemainingMl ?? 0,
    usages: s.usages ?? [],
    updatedAt: s.updatedAt ?? parseTime(s.preparedAt, nowMs),
  }
}

/** v2 までのセッションはすべてこの端末で作られたもの */
export function migrateSession(
  s: Omit<Session, 'deviceId'> & { deviceId?: string },
  selfDeviceId: string,
): Session {
  return { ...s, deviceId: s.deviceId ?? selfDeviceId }
}
