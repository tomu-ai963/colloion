import type {
  AnyRecord,
  PullChange,
  PullResponse,
  PushRequest,
  PushResponse,
  PushResult,
  SyncTransport,
} from './protocol'
import { PULL_PAGE_LIMIT } from './protocol'

/**
 * サーバー側の振る舞いの基準実装（1 ユーザー分、インメモリ）。
 * テストで複数端末を同期させる相手として使う。Worker（Step 3）はこれと同じ規則で実装する。
 */
export class MemorySyncServer {
  private seq = 0
  private records = new Map<string, PullChange>()

  push(req: PushRequest): PushResponse {
    const results: PushResult[] = req.changes.map((c) => {
      const key = `${c.kind}:${c.id}`
      const cur = this.records.get(key)
      if (cur && cur.rev !== c.baseRev) {
        return { kind: c.kind, id: c.id, status: 'conflict', current: structuredClone(cur.record) }
      }
      const rev = ++this.seq
      const record = { ...structuredClone(c.record), rev } as AnyRecord
      this.records.set(key, { kind: c.kind, id: c.id, rev, record })
      return { kind: c.kind, id: c.id, status: 'ok', rev }
    })
    return { results }
  }

  pull(since: number, limit = PULL_PAGE_LIMIT): PullResponse {
    const newer = [...this.records.values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev)
    const page = newer.slice(0, limit)
    return {
      changes: structuredClone(page),
      cursor: page.length > 0 ? page[page.length - 1]!.rev : since,
      hasMore: newer.length > page.length,
    }
  }

  /** テスト用: サーバー上の現在の版 */
  get(kind: string, id: string): AnyRecord | undefined {
    return this.records.get(`${kind}:${id}`)?.record
  }

  /** この端末からの通信路。offline にすると通信失敗を模す */
  transport(opts: { offline?: () => boolean; pullLimit?: number } = {}): SyncTransport {
    const check = () => {
      if (opts.offline?.()) throw new TypeError('Failed to fetch')
    }
    return {
      push: async (req) => {
        check()
        return this.push(structuredClone(req))
      },
      pull: async (since) => {
        check()
        return this.pull(since, opts.pullLimit)
      },
    }
  }
}
