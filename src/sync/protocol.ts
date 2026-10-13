/**
 * クライアント ⇄ Worker の同期プロトコル（Phase 3）。Worker 側もこの型を共有する。
 *
 * - rev はサーバーがユーザーごとに振る通し番号。レコードの版であると同時に、
 *   pull の位置（cursor）にもなる
 * - push は「どの版を元に書き換えたか（baseRev）」を添える。サーバー上の版と
 *   一致しなければ競合として現在の版を返し、マージはクライアントが行う
 */

import type { SyncKind, SyncRecordMap } from '../core/merge'

export const SYNC_KINDS: readonly SyncKind[] = ['batch', 'reagent', 'stock', 'pipette', 'session']

/** 1 回の push で送る最大件数 */
export const PUSH_BATCH_LIMIT = 100
/** 1 回の pull で返す最大件数 */
export const PULL_PAGE_LIMIT = 200

export type AnyRecord = SyncRecordMap[SyncKind]

export interface PushChange {
  kind: SyncKind
  id: string
  /** 元にした版。サーバーに一度も送っていなければ null */
  baseRev: number | null
  record: AnyRecord
}

export interface PushRequest {
  changes: PushChange[]
}

export type PushResult =
  | { kind: SyncKind; id: string; status: 'ok'; rev: number }
  /** current はサーバー上の現在の版（rev 付き） */
  | { kind: SyncKind; id: string; status: 'conflict'; current: AnyRecord }

export interface PushResponse {
  results: PushResult[]
}

export interface PullChange {
  kind: SyncKind
  id: string
  rev: number
  record: AnyRecord
}

export interface PullResponse {
  changes: PullChange[]
  /** 次回の since。変更が無ければ渡した since のまま */
  cursor: number
  hasMore: boolean
}

/** 通信層。HTTP 実装は Step 3、テストではインメモリのサーバーを使う */
export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>
  pull(since: number): Promise<PullResponse>
}

/** 認証切れ（401）。エンジンはこれを受けたら再試行せず止まる */
export class SyncAuthError extends Error {
  constructor(message = '認証が必要です') {
    super(message)
    this.name = 'SyncAuthError'
  }
}
