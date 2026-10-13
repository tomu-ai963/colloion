import { preserveAppendOnly, type SyncKind, type SyncRecordMap } from '../core/merge'

/**
 * 送信待ちキューの1件。キーは `${kind}:${id}` で、同じレコードへの変更は1件にまとまる
 * （Run Mode の 10 秒ごとの保存でもキューが増え続けない）。
 * レコード本体は持たず、送信時点の最新版を読み直す。
 * n は書き込みのたびに増える版番号で、送信中に新しい変更が入った場合に
 * 送信完了の確認（ack）でその変更まで消さないために使う。
 */
export interface OutboxEntry {
  key: string
  kind: SyncKind
  id: string
  n: number
  queuedAt: number
}

export const outboxKey = (kind: SyncKind, id: string): string => `${kind}:${id}`

/** updateRecord に渡す更新関数の戻り値 */
export interface RecordUpdate<T> {
  /** 書き込む版。undefined なら書かない */
  next?: T
  /** 書いた後に送信待ちへ積むか */
  enqueue?: boolean
}

/**
 * 同期エンジンから見たローカル側。アプリ向けの StorageAdapter と同じ実装が兼ねる。
 * - アプリからの save* / delete* は、レコードの書き込みと送信待ちへの追加を同じトランザクションで行う
 * - エンジンがサーバー由来の版を書くときは updateRecord を使う。読み込み・マージ・書き込みが
 *   1 トランザクションに収まるので、間にアプリの保存が割り込んで上書きすることがない
 *   （fn は同期関数でなければならない）
 */
export interface SyncStore {
  getDeviceId(): Promise<string>
  /** 墓標付きのレコードも返す */
  getRecord<K extends SyncKind>(kind: K, id: string): Promise<SyncRecordMap[K] | undefined>
  updateRecord<K extends SyncKind>(
    kind: K,
    id: string,
    fn: (current: SyncRecordMap[K] | undefined) => RecordUpdate<SyncRecordMap[K]>,
  ): Promise<{ before?: SyncRecordMap[K]; after?: SyncRecordMap[K] }>
  enqueue(kind: SyncKind, id: string): Promise<void>
  /** 全レコードを送信待ちに積む（初回ログイン時に既存データをまとめて送るため） */
  enqueueAll(): Promise<void>
  readOutbox(limit: number): Promise<OutboxEntry[]>
  /** 送信済みの確認。読んだ時点から版番号 n が変わっていない（新しい変更が無い）ものだけ消す */
  ackOutbox(entries: Pick<OutboxEntry, 'key' | 'n'>[]): Promise<void>
  countOutbox(): Promise<number>
  getMeta(key: string): Promise<string | undefined>
  setMeta(key: string, value: string | null): Promise<void>
  /** アプリからの書き込み（送信待ちが増えた）を知らせる。戻り値で購読解除 */
  onLocalChange(listener: () => void): () => void
}

/** onLocalChange の購読者を持つだけの小さな仕組み */
export class ChangeNotifier {
  private listeners = new Set<() => void>()
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notify(): void {
    for (const l of this.listeners) l()
  }
}

/**
 * アプリからの保存で書く版。アプリ側の状態は同期前の古い版のことがあるため、
 * rev を下げず、追記のみのデータ（母液の使用記録・measured）を失わない。
 */
export function rebaseLocalWrite<K extends SyncKind>(
  kind: K,
  incoming: SyncRecordMap[K],
  existing: SyncRecordMap[K] | undefined,
): SyncRecordMap[K] {
  const merged = preserveAppendOnly(kind, incoming, existing)
  const rev = Math.max(incoming.rev ?? -1, existing?.rev ?? -1)
  return rev < 0 ? merged : { ...merged, rev }
}
