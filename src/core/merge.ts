/**
 * 端末間同期のマージ規則（Phase 3）。すべて純関数。
 *
 * local = この端末の IndexedDB にある版、remote = サーバーから届いた版。
 * 競合の判定（どちらが新しい版を元にしたか）はサーバーの rev で行うが、
 * 競合したときに「どちらを残すか」はここで決める。
 *
 * 共通の規則:
 * - 削除の墓標（deletedAt）は編集より強い。削除と編集が競合したら削除が残る
 * - それ以外は updatedAt が新しい方。同値ならサーバー側（remote）
 * - rev は両者の大きい方を引き継ぐ（次に送るときの baseRev になる）
 */

import type { Batch, Pipette, Reagent, Stock, StockUsage } from './model'
import type { Session } from './session'

export type SyncKind = 'batch' | 'reagent' | 'stock' | 'pipette' | 'session'

export interface SyncRecordMap {
  batch: Batch
  reagent: Reagent
  stock: Stock
  pipette: Pipette
  session: Session
}

interface Versioned {
  updatedAt: number
  deletedAt?: number
  rev?: number
}

const maxRev = (a?: number, b?: number): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

const withRev = <T extends Versioned>(winner: T, local: T, remote: T): T => {
  const rev = maxRev(local.rev, remote.rev)
  return rev === undefined ? winner : { ...winner, rev }
}

/** 墓標があれば墓標側、なければ updatedAt が新しい方。勝った側をそのまま返す（rev は未調整） */
function pickWinner<T extends Versioned>(local: T, remote: T): T {
  const ld = local.deletedAt
  const rd = remote.deletedAt
  if (ld !== undefined || rd !== undefined) {
    if (ld === undefined) return remote
    if (rd === undefined) return local
    return ld > rd ? local : remote
  }
  return local.updatedAt > remote.updatedAt ? local : remote
}

/** 後勝ち（Reagent / Pipette） */
export function mergeLww<T extends Versioned>(local: T, remote: T): T {
  return withRev(pickWinner(local, remote), local, remote)
}

/**
 * Batch: 条件と computed は保存後に変わらないので、実際に競合するのは result と measured。
 * result は後勝ち。measured はセッションを開いた端末が一度だけ書くので、
 * 負けた側にしか無ければ拾う（後勝ちで消さない）。
 */
export function mergeBatch(local: Batch, remote: Batch): Batch {
  const winner = pickWinner(local, remote)
  if (winner.deletedAt !== undefined) return withRev(winner, local, remote)
  const loser = winner === local ? remote : local
  const measured = winner.measured ?? loser.measured
  return withRev(measured ? { ...winner, measured } : winner, local, remote)
}

/** 使用記録の和集合（id で重複除去、時刻順） */
export function unionUsages(a: StockUsage[], b: StockUsage[]): StockUsage[] {
  const byId = new Map<string, StockUsage>()
  for (const u of [...a, ...b]) if (!byId.has(u.id)) byId.set(u.id, u)
  return [...byId.values()].sort((x, y) => x.at - y.at || x.id.localeCompare(y.id))
}

/** Stock: usages は和集合、それ以外は後勝ち */
export function mergeStock(local: Stock, remote: Stock): Stock {
  const winner = pickWinner(local, remote)
  if (winner.deletedAt !== undefined) return withRev(winner, local, remote)
  return withRev({ ...winner, usages: unionUsages(local.usages, remote.usages) }, local, remote)
}

/**
 * Session: 書き込めるのは開いた端末（deviceId）だけ。
 * 自端末のセッションならローカルが正、他端末のものならサーバーが正。
 * 墓標は他と同じく編集より強い。
 */
export function mergeSession(local: Session, remote: Session, selfDeviceId: string): Session {
  if (local.deletedAt !== undefined || remote.deletedAt !== undefined) {
    return withRev(pickWinner(local, remote), local, remote)
  }
  const winner = local.deviceId === selfDeviceId ? local : remote
  return withRev(winner, local, remote)
}

/**
 * アプリからの保存（ローカルの書き込み）で、追記のみのデータを失わないようにする。
 * アプリの状態は同期で届いた変更を反映する前の古い版のことがあり、
 * そのまま保存すると他端末の使用記録（Stock.usages）や measured が消えるため。
 * それ以外のフィールドは書き込む側（incoming）が正。
 */
export function preserveAppendOnly<K extends SyncKind>(
  kind: K,
  incoming: SyncRecordMap[K],
  existing: SyncRecordMap[K] | undefined,
): SyncRecordMap[K] {
  if (!existing) return incoming
  if (kind === 'stock') {
    const s = incoming as Stock
    return { ...s, usages: unionUsages((existing as Stock).usages, s.usages) } as SyncRecordMap[K]
  }
  if (kind === 'batch') {
    const b = incoming as Batch
    const measured = b.measured ?? (existing as Batch).measured
    return (measured ? { ...b, measured } : b) as SyncRecordMap[K]
  }
  return incoming
}

/** 種類ごとのマージ規則を引く */
export function mergeRecord<K extends SyncKind>(
  kind: K,
  local: SyncRecordMap[K],
  remote: SyncRecordMap[K],
  selfDeviceId: string,
): SyncRecordMap[K] {
  switch (kind) {
    case 'batch':
      return mergeBatch(local as Batch, remote as Batch) as SyncRecordMap[K]
    case 'stock':
      return mergeStock(local as Stock, remote as Stock) as SyncRecordMap[K]
    case 'session':
      return mergeSession(local as Session, remote as Session, selfDeviceId) as SyncRecordMap[K]
    default:
      return mergeLww(local, remote)
  }
}
