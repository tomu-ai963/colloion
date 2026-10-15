/**
 * 同期エンジン（Phase 3 Step 2）。
 *
 * この端末の IndexedDB が正本で、サーバーとは差分だけをやり取りする。
 * 1 回の同期は「pull → push（競合があれば最大 MAX_PUSH_ROUNDS 回まで繰り返す）」。
 *
 * - pull: サーバー上で cursor 以降に変わったレコードを受け取り、ローカルとマージする。
 *   マージ結果がサーバーの版と違えば（こちらに未送信の変更がある等）送信待ちに積む
 * - push: 送信待ちのレコードを最新版で読み直し、baseRev（元にした版）を添えて送る。
 *   競合が返ったらサーバーの版とマージし、必要なら次のラウンドで送り直す
 * - 削除（墓標）は他の変更より先に、単独のラウンドで送る。容量上限のサーバーは追加を含む
 *   push を丸ごと断るので、混ぜると削除まで止まり、削除で空きを作れなくなるため
 *
 * 送信の予約は「ローカルの書き込みから DEBOUNCE_MS 後、ただし前回の同期から
 * MIN_INTERVAL_MS は空ける」。Run Mode は 10 秒ごとに保存するが、
 * 通電中のセッションが送られるのは最短でも MIN_INTERVAL_MS ごとになる。
 */

import { mergeRecord, type SyncKind } from '../core/merge'
import type { SyncStore } from '../storage/SyncStore'
import { deepEqual } from './equal'
import {
  PUSH_BATCH_LIMIT,
  SyncAuthError,
  SyncForbiddenError,
  SyncQuotaError,
  type AnyRecord,
  type PushChange,
  type SyncTransport,
} from './protocol'

export const DEBOUNCE_MS = 2_000
export const MIN_INTERVAL_MS = 30_000
/** タブを開いている間、他端末の変更を取りに行く間隔 */
export const POLL_INTERVAL_MS = 5 * 60_000
const MAX_PUSH_ROUNDS = 3
const RETRY_BASE_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000

const META_CURSOR = 'pullCursor'
const META_USER = 'syncUserId'

export type SyncPhase =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'unauthorized'
  | 'forbidden'
  /** 容量上限。pull は済んでいる。間隔を空けた再試行はせず、書き込みと定期の同期で試し直す */
  | 'quota'

export interface SyncStatus {
  phase: SyncPhase
  /** 送信待ちの件数 */
  pending: number
  lastSyncedAt: number | null
  error: string | null
}

export interface SyncReport {
  pulled: number
  pushed: number
  conflicts: number
}

export interface SyncEngineOptions {
  /** サーバー由来の変更をローカルに書いたとき（アプリの状態を読み直す） */
  onApplied?(kinds: Set<SyncKind>): void
  onStatus?(status: SyncStatus): void
}

/** 通信できなかった（fetch の失敗）か */
const isNetworkError = (e: unknown): boolean => e instanceof TypeError

/** rev（サーバーの版番号）を除いた中身が同じか */
const sameContent = (a: AnyRecord, b: AnyRecord): boolean =>
  deepEqual({ ...a, rev: undefined }, { ...b, rev: undefined }) // deepEqual は undefined のキーを無視する

export class SyncEngine {
  private status: SyncStatus = { phase: 'idle', pending: 0, lastSyncedAt: null, error: null }
  private running: Promise<SyncReport> | null = null
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private scheduledAt = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastRunAt = 0
  private failures = 0
  private deviceId: string | null = null
  private detach: (() => void)[] = []

  constructor(
    private store: SyncStore,
    private transport: SyncTransport,
    private opts: SyncEngineOptions = {},
  ) {}

  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * ログインしたユーザーに結びつける。前回と別のユーザー（または初回）なら
   * pull を最初からやり直し、この端末の全レコードを送信待ちに積む。
   */
  async attach(userId: string): Promise<void> {
    const prev = await this.store.getMeta(META_USER)
    if (prev !== userId) {
      await this.store.setMeta(META_CURSOR, null)
      await this.store.enqueueAll()
      await this.store.setMeta(META_USER, userId)
    }
    await this.refreshPending()
  }

  /** 同期を1回行う。実行中に呼ばれたら、終わった後にもう1回だけ行う */
  syncOnce(): Promise<SyncReport> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        this.schedule(0)
      }
    })
    return this.running
  }

  private async run(): Promise<SyncReport> {
    this.lastRunAt = Date.now()
    this.setStatus({ phase: 'syncing', error: null })
    try {
      this.deviceId ??= await this.store.getDeviceId()
      const applied = new Set<SyncKind>()
      const pulled = await this.pull(applied)
      let pushed = 0
      let conflicts = 0
      for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
        const r = await this.pushRound(applied)
        pushed += r.pushed
        conflicts += r.conflicts
        // 削除だけを送ったラウンドの後は、残りの変更を続けて送る
        if (!r.more && (r.sent === 0 || r.conflicts === 0)) break
      }
      if (applied.size > 0) this.opts.onApplied?.(applied)
      this.failures = 0
      await this.refreshPending()
      this.setStatus({ phase: 'idle', lastSyncedAt: Date.now() })
      return { pulled, pushed, conflicts }
    } catch (e) {
      await this.refreshPending().catch(() => {})
      if (e instanceof SyncAuthError) {
        this.setStatus({ phase: 'unauthorized', error: e.message })
      } else if (e instanceof SyncForbiddenError) {
        this.setStatus({ phase: 'forbidden', error: e.message })
      } else if (e instanceof SyncQuotaError) {
        this.setStatus({ phase: 'quota', error: e.message })
      } else {
        this.failures++
        this.setStatus({
          phase: isNetworkError(e) ? 'offline' : 'error',
          error: e instanceof Error ? e.message : String(e),
        })
        this.schedule(Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS))
      }
      throw e
    }
  }

  private async pull(applied: Set<SyncKind>): Promise<number> {
    let cursor = Number((await this.store.getMeta(META_CURSOR)) ?? 0)
    let count = 0
    for (;;) {
      const page = await this.transport.pull(cursor)
      for (const c of page.changes) {
        if (await this.applyRemote(c.kind, c.record)) applied.add(c.kind)
        count++
      }
      cursor = page.cursor
      await this.store.setMeta(META_CURSOR, String(cursor))
      if (!page.hasMore) return count
    }
  }

  /**
   * サーバーの版をローカルに取り込む（1 トランザクション）。内容が変わったら true。
   * マージ結果がサーバーの版と違えば（未送信の変更がある・自端末のセッション等）送信待ちに積む。
   */
  private async applyRemote(kind: SyncKind, remote: AnyRecord): Promise<boolean> {
    const deviceId = this.deviceId!
    const { before, after } = await this.store.updateRecord(kind, remote.id, (local) => {
      if (!local) return { next: remote }
      const merged = mergeRecord(kind, local, remote, deviceId)
      return {
        next: deepEqual(merged, local) ? undefined : merged,
        enqueue: !sameContent(merged, remote),
      }
    })
    return !before || !sameContent(after!, before)
  }

  private async pushRound(applied: Set<SyncKind>) {
    const read = await this.store.readOutbox(PUSH_BATCH_LIMIT)
    // readOutbox は削除が先。削除があれば今回は削除だけを送る
    const entries = read[0]?.deleted ? read.filter((e) => e.deleted) : read
    const more = entries.length < read.length
    const changes: PushChange[] = []
    const sentN = new Map<string, number>()
    const gone: { key: string; n: number }[] = []
    for (const e of entries) {
      const record = await this.store.getRecord(e.kind, e.id)
      // 一度もサーバーに届いていない（rev の無い）レコードの削除は送らない。
      // 送ると、サーバーに無いものの墓標を作って容量を使うだけになる。
      // 実はサーバーに届いていた（応答だけ失った）場合も、次の pull でその版が届き、
      // 墓標が勝って rev 付きで送り直される
      if (!record || (record.deletedAt !== undefined && record.rev === undefined)) {
        gone.push(e)
        continue
      }
      changes.push({ kind: e.kind, id: e.id, baseRev: record.rev ?? null, record })
      sentN.set(e.key, e.n)
    }
    if (gone.length > 0) await this.store.ackOutbox(gone)
    if (changes.length === 0) return { sent: 0, pushed: 0, conflicts: 0, more }

    const { results } = await this.transport.push({ changes })
    const deviceId = this.deviceId!
    let pushed = 0
    let conflicts = 0
    for (const r of results) {
      const key = `${r.kind}:${r.id}`
      const n = sentN.get(key)
      if (n === undefined) continue
      // 先に ack する（版番号 n が送信時のままなら消える。送信中に書き込みがあれば残る）
      await this.store.ackOutbox([{ key, n }])
      if (r.status === 'ok') {
        pushed++
        // 送信後にローカルが更新されていても、その更新は送った版の続きなので rev を引き継いでよい
        await this.store.updateRecord(r.kind, r.id, (local) => ({
          next: local ? { ...local, rev: Math.max(local.rev ?? 0, r.rev) } : undefined,
        }))
        continue
      }
      conflicts++
      const { before, after } = await this.store.updateRecord(r.kind, r.id, (local) => {
        if (!local) return { next: r.current }
        const merged = mergeRecord(r.kind, local, r.current, deviceId)
        // サーバーの版と違う（こちらの変更が残る）なら次のラウンドで送り直す
        return { next: merged, enqueue: !sameContent(merged, r.current) }
      })
      if (!before || !sameContent(after!, before)) applied.add(r.kind)
    }
    return { sent: changes.length, pushed, conflicts, more }
  }

  // ---- 予約と自動実行 ----

  /** 書き込みのあとに呼ぶ。DEBOUNCE_MS 後、前回から MIN_INTERVAL_MS 空けて同期する */
  requestSync(): void {
    if (this.status.phase === 'unauthorized' || this.status.phase === 'forbidden') return
    const sinceLast = Date.now() - this.lastRunAt
    this.schedule(Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - sinceLast))
  }

  /** delayMs 後に同期。既に早い予約があればそちらを残す */
  private schedule(delayMs: number): void {
    const at = Date.now() + delayMs
    if (this.timer !== null && this.scheduledAt <= at) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.scheduledAt = at
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncOnce().catch(() => {})
    }, delayMs)
  }
  /**
   * 自動同期を始める: 直後に1回、書き込みのたび、オンライン復帰・タブ復帰で即時、
   * 表示中は POLL_INTERVAL_MS ごと。
   */
  start(): void {
    this.stop()
    this.detach.push(this.store.onLocalChange(() => this.requestSync()))
    if (typeof window !== 'undefined') {
      const now = () => this.schedule(0)
      const onVisible = () => {
        if (document.visibilityState === 'visible') now()
      }
      window.addEventListener('online', now)
      document.addEventListener('visibilitychange', onVisible)
      this.detach.push(() => window.removeEventListener('online', now))
      this.detach.push(() => document.removeEventListener('visibilitychange', onVisible))
    }
    this.pollTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.schedule(0)
    }, POLL_INTERVAL_MS)
    this.schedule(0)
  }

  stop(): void {
    for (const d of this.detach.splice(0)) d()
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.timer = null
    this.pollTimer = null
  }

  private async refreshPending() {
    this.setStatus({ pending: await this.store.countOutbox() })
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch }
    this.opts.onStatus?.(this.status)
  }
}
