import { newId } from '../core/id'
import { emptyCounts, resolveImport, type ImportItem } from './backup'
import type { SyncKind, SyncRecordMap } from '../core/merge'
import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import type { StorageAdapter } from './StorageAdapter'
import {
  ChangeNotifier,
  outboxKey,
  rebaseLocalWrite,
  type OutboxEntry,
  type RecordUpdate,
  type SyncStore,
} from './SyncStore'

type Tables = { [K in SyncKind]: Map<string, SyncRecordMap[K]> }

/** テスト・IndexedDB 非対応環境向けのインメモリ実装 */
export class MemoryAdapter implements StorageAdapter, SyncStore {
  private deviceId = newId()
  private tables: Tables = {
    batch: new Map(),
    reagent: new Map(),
    stock: new Map(),
    pipette: new Map(),
    session: new Map(),
  }
  private outbox = new Map<string, OutboxEntry>()
  private meta = new Map<string, string>()
  private changes = new ChangeNotifier()

  async getDeviceId() {
    return this.deviceId
  }

  // ---- アプリ向け（StorageAdapter） ----

  private live<K extends SyncKind>(kind: K): SyncRecordMap[K][] {
    return [...this.tables[kind].values()].filter((v) => v.deletedAt === undefined)
  }

  private save<K extends SyncKind>(kind: K, record: SyncRecordMap[K]) {
    const table = this.tables[kind] as Map<string, SyncRecordMap[K]>
    table.set(record.id, structuredClone(rebaseLocalWrite(kind, record, table.get(record.id))))
    this.enqueueSync(kind, record.id)
    this.changes.notify()
  }

  private tombstone(kind: SyncKind, id: string) {
    const table = this.tables[kind] as Map<string, SyncRecordMap[SyncKind]>
    const cur = table.get(id)
    if (!cur) return
    const now = Date.now()
    table.set(id, { ...cur, deletedAt: now, updatedAt: now })
    this.enqueueSync(kind, id)
    this.changes.notify()
  }

  async listBatches() {
    return this.live('batch').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveBatch(batch: Batch) {
    this.save('batch', batch)
  }
  async deleteBatch(id: string) {
    this.tombstone('batch', id)
  }

  async listReagents() {
    return this.live('reagent')
  }
  async saveReagent(reagent: Reagent) {
    this.save('reagent', reagent)
  }
  async deleteReagent(id: string) {
    this.tombstone('reagent', id)
  }

  async listStocks() {
    return this.live('stock').sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
  }
  async saveStock(stock: Stock) {
    this.save('stock', stock)
  }
  async deleteStock(id: string) {
    this.tombstone('stock', id)
  }

  async listPipettes() {
    return this.live('pipette')
  }
  async savePipette(pipette: Pipette) {
    this.save('pipette', pipette)
  }

  async listSessions() {
    return this.live('session').sort((a, b) => b.startedAt - a.startedAt)
  }
  async saveSession(session: Session) {
    this.save('session', session)
  }
  async deleteSession(id: string) {
    this.tombstone('session', id)
  }

  async importRecords(items: ImportItem[]) {
    const counts = emptyCounts()
    for (const { kind, record } of items) {
      const table = this.tables[kind] as Map<string, typeof record>
      const { outcome, next } = resolveImport(kind, table.get(record.id), record, this.deviceId)
      counts[outcome]++
      if (next) {
        table.set(record.id, structuredClone(next))
        this.enqueueSync(kind, record.id)
      }
    }
    if (counts.added + counts.updated > 0) this.changes.notify()
    return counts
  }

  // ---- 同期エンジン向け（SyncStore） ----

  private enqueueSync(kind: SyncKind, id: string) {
    const key = outboxKey(kind, id)
    const n = (this.outbox.get(key)?.n ?? 0) + 1
    this.outbox.set(key, { key, kind, id, n, queuedAt: Date.now() })
  }

  async getRecord<K extends SyncKind>(kind: K, id: string) {
    const v = this.tables[kind].get(id)
    return v === undefined ? undefined : structuredClone(v)
  }
  async updateRecord<K extends SyncKind>(
    kind: K,
    id: string,
    fn: (current: SyncRecordMap[K] | undefined) => RecordUpdate<SyncRecordMap[K]>,
  ) {
    const table = this.tables[kind] as Map<string, SyncRecordMap[K]>
    const cur = table.get(id)
    const before = cur === undefined ? undefined : structuredClone(cur)
    const { next, enqueue } = fn(before === undefined ? undefined : structuredClone(before))
    if (next !== undefined) table.set(id, structuredClone(next))
    if (enqueue) this.enqueueSync(kind, id)
    return { before, after: next ?? before }
  }
  async enqueue(kind: SyncKind, id: string) {
    this.enqueueSync(kind, id)
  }
  async enqueueAll() {
    for (const kind of Object.keys(this.tables) as SyncKind[]) {
      for (const id of this.tables[kind].keys()) this.enqueueSync(kind, id)
    }
  }
  async readOutbox(limit: number) {
    return [...this.outbox.values()].sort((a, b) => a.queuedAt - b.queuedAt).slice(0, limit)
  }
  async ackOutbox(entries: Pick<OutboxEntry, 'key' | 'n'>[]) {
    for (const e of entries) if (this.outbox.get(e.key)?.n === e.n) this.outbox.delete(e.key)
  }
  async countOutbox() {
    return this.outbox.size
  }
  async getMeta(key: string) {
    return this.meta.get(key)
  }
  async setMeta(key: string, value: string | null) {
    if (value === null) this.meta.delete(key)
    else this.meta.set(key, value)
  }
  onLocalChange(listener: () => void) {
    return this.changes.subscribe(listener)
  }
}
