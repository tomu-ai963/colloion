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

/**
 * 1 回の push で送る最大件数。Worker は 1 件につき 1 文 + 競合の読み直し 1 文を D1 に投げる。
 * D1 の「1 呼び出しあたりのクエリ数」は Workers Free で 50 なので、それに収める。
 */
export const PUSH_BATCH_LIMIT = 40
/** 1 回の pull で返す最大件数 */
export const PULL_PAGE_LIMIT = 200
/** 1 レコードの JSON の最大バイト数（通電セッションの区間・マークが増えても収まる大きさ） */
export const MAX_RECORD_BYTES = 256 * 1024
/** push のリクエスト本文の最大バイト数 */
export const MAX_PUSH_BYTES = 4 * 1024 * 1024
/** レコード ID に使える文字（UUID・seed-*・default-pipette・フォールバック ID） */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

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
