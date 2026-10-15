import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { newId } from '../core/id'
import { emptyCounts, resolveImport, type ImportItem } from './backup'
import type { SyncKind, SyncRecordMap } from '../core/merge'
import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import {
  migrateBatch,
  migratePipette,
  migrateReagent,
  migrateSession,
  migrateStock,
  type LegacyStock,
} from './migrate'
import type { StorageAdapter } from './StorageAdapter'
import {
  ChangeNotifier,
  outboxKey,
  rebaseLocalWrite,
  type OutboxEntry,
  type RecordUpdate,
  type SyncStore,
} from './SyncStore'

interface ColloionDB extends DBSchema {
  batches: { key: string; value: Batch }
  reagents: { key: string; value: Reagent }
  stocks: { key: string; value: Stock }
  pipettes: { key: string; value: Pipette }
  sessions: { key: string; value: Session }
  /** v3: 端末 ID・最終同期位置などのキーバリュー */
  meta: { key: string; value: string }
  /** v4: 同期の送信待ちキュー（キー = kind:id） */
  outbox: { key: string; value: OutboxEntry }
}

type RecordStore = 'batches' | 'reagents' | 'stocks' | 'pipettes' | 'sessions'

const STORE_OF: { [K in SyncKind]: RecordStore } = {
  batch: 'batches',
  reagent: 'reagents',
  stock: 'stocks',
  pipette: 'pipettes',
  session: 'sessions',
}

const DEVICE_ID_KEY = 'deviceId'

type WriteTx = IDBPTransaction<ColloionDB, (RecordStore | 'outbox')[], 'readwrite'>

/** 送信待ちに積む（同じレコードは1件にまとまり、版番号 n が進む） */
async function enqueueIn(tx: WriteTx, kind: SyncKind, id: string) {
  const outbox = tx.objectStore('outbox')
  const key = outboxKey(kind, id)
  const cur = await outbox.get(key)
  await outbox.put({ key, kind, id, n: (cur?.n ?? 0) + 1, queuedAt: Date.now() })
}

export class IndexedDbAdapter implements StorageAdapter, SyncStore {
  private dbPromise: Promise<IDBPDatabase<ColloionDB>>
  private deviceIdPromise: Promise<string> | undefined
  private changes = new ChangeNotifier()

  constructor(dbName = 'colloion') {
    this.dbPromise = openDB<ColloionDB>(dbName, 4, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          db.createObjectStore('batches', { keyPath: 'id' })
          db.createObjectStore('reagents', { keyPath: 'id' })
          db.createObjectStore('stocks', { keyPath: 'id' })
          db.createObjectStore('pipettes', { keyPath: 'id' })
        }
        if (oldVersion < 2) {
          db.createObjectStore('sessions', { keyPath: 'id' })
        }
        if (oldVersion < 3) {
          db.createObjectStore('meta')

          // 既存レコードに同期メタ情報を補完する。
          // upgrade 中は IDB 以外の await を挟まない（トランザクションが閉じるため）
          const now = Date.now()
          const deviceId = newId()
          await tx.objectStore('meta').put(deviceId, DEVICE_ID_KEY)

          const rewrite = async <S extends RecordStore>(
            store: S,
            fn: (v: never) => ColloionDB[S]['value'],
          ) => {
            let cursor = await tx.objectStore(store).openCursor()
            while (cursor) {
              await cursor.update(fn(cursor.value as never))
              cursor = await cursor.continue()
            }
          }
          await rewrite('batches', (v: Parameters<typeof migrateBatch>[0]) => migrateBatch(v, now))
          await rewrite('reagents', (v: Parameters<typeof migrateReagent>[0]) =>
            migrateReagent(v, now),
          )
          await rewrite('stocks', (v: LegacyStock) => migrateStock(v, now))
          await rewrite('pipettes', (v: Parameters<typeof migratePipette>[0]) =>
            migratePipette(v, now),
          )
          await rewrite('sessions', (v: Parameters<typeof migrateSession>[0]) =>
            migrateSession(v, deviceId),
          )
        }
        if (oldVersion < 4) {
          // v3 の outbox は保存ごとに1行増える形だった。kind:id キーで作り直す
          if (db.objectStoreNames.contains('outbox')) db.deleteObjectStore('outbox')
          db.createObjectStore('outbox', { keyPath: 'key' })
        }
      },
    })
  }

  getDeviceId() {
    this.deviceIdPromise ??= (async () => {
      const db = await this.dbPromise
      const existing = await db.get('meta', DEVICE_ID_KEY)
      if (existing) return existing
      const id = newId()
      await db.put('meta', id, DEVICE_ID_KEY)
      return id
    })()
    return this.deviceIdPromise
  }

  // ---- アプリ向け（StorageAdapter） ----

  /** 墓標の付いていないレコードだけ */
  private async listLive<K extends SyncKind>(kind: K): Promise<SyncRecordMap[K][]> {
    const all = (await (await this.dbPromise).getAll(STORE_OF[kind])) as SyncRecordMap[K][]
    return all.filter((v) => v.deletedAt === undefined)
  }

  /** レコードの保存と送信待ちへの追加を1トランザクションで（rev は下げない） */
  private async save<K extends SyncKind>(kind: K, record: SyncRecordMap[K]) {
    const db = await this.dbPromise
    const tx = db.transaction([STORE_OF[kind], 'outbox'], 'readwrite')
    const store = tx.objectStore(STORE_OF[kind])
    const existing = (await store.get(record.id)) as SyncRecordMap[K] | undefined
    await store.put(rebaseLocalWrite(kind, record, existing))
    await enqueueIn(tx, kind, record.id)
    await tx.done
    this.changes.notify()
  }

  /** 物理削除せず墓標を書く */
  private async tombstone(kind: SyncKind, id: string) {
    const db = await this.dbPromise
    const tx = db.transaction([STORE_OF[kind], 'outbox'], 'readwrite')
    const store = tx.objectStore(STORE_OF[kind])
    const cur = await store.get(id)
    if (cur) {
      const now = Date.now()
      await store.put({ ...cur, deletedAt: now, updatedAt: now })
      await enqueueIn(tx, kind, id)
    }
    await tx.done
    if (cur) this.changes.notify()
  }

  async listBatches() {
    const all = await this.listLive('batch')
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  saveBatch(batch: Batch) {
    return this.save('batch', batch)
  }
  deleteBatch(id: string) {
    return this.tombstone('batch', id)
  }

  listReagents() {
    return this.listLive('reagent')
  }
  saveReagent(reagent: Reagent) {
    return this.save('reagent', reagent)
  }
  deleteReagent(id: string) {
    return this.tombstone('reagent', id)
  }

  async listStocks() {
    const all = await this.listLive('stock')
    return all.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
  }
  saveStock(stock: Stock) {
    return this.save('stock', stock)
  }
  deleteStock(id: string) {
    return this.tombstone('stock', id)
  }

  listPipettes() {
    return this.listLive('pipette')
  }
  savePipette(pipette: Pipette) {
    return this.save('pipette', pipette)
  }

  async listSessions() {
    const all = await this.listLive('session')
    return all.sort((a, b) => b.startedAt - a.startedAt)
  }
  saveSession(session: Session) {
    return this.save('session', session)
  }
  deleteSession(id: string) {
    return this.tombstone('session', id)
  }

  async importRecords(items: ImportItem[]) {
    // トランザクションの中で IDB 以外を await すると閉じるので、端末 ID は先に読む
    const selfDeviceId = await this.getDeviceId()
    const db = await this.dbPromise
    const kinds = Object.keys(STORE_OF) as SyncKind[]
    const tx = db.transaction([...kinds.map((k) => STORE_OF[k]), 'outbox'], 'readwrite')
    const counts = emptyCounts()
    for (const { kind, record } of items) {
      const store = tx.objectStore(STORE_OF[kind])
      const existing = (await store.get(record.id)) as typeof record | undefined
      const { outcome, next } = resolveImport(kind, existing, record, selfDeviceId)
      counts[outcome]++
      if (next) {
        await store.put(next as never)
        await enqueueIn(tx, kind, record.id)
      }
    }
    await tx.done
    if (counts.added + counts.updated > 0) this.changes.notify()
    return counts
  }

  // ---- 同期エンジン向け（SyncStore） ----

  async getRecord<K extends SyncKind>(kind: K, id: string) {
    return (await (await this.dbPromise).get(STORE_OF[kind], id)) as SyncRecordMap[K] | undefined
  }

  async updateRecord<K extends SyncKind>(
    kind: K,
    id: string,
    fn: (current: SyncRecordMap[K] | undefined) => RecordUpdate<SyncRecordMap[K]>,
  ) {
    const db = await this.dbPromise
    const tx = db.transaction([STORE_OF[kind], 'outbox'], 'readwrite')
    const store = tx.objectStore(STORE_OF[kind])
    const before = (await store.get(id)) as SyncRecordMap[K] | undefined
    const { next, enqueue } = fn(before)
    if (next !== undefined) await store.put(next)
    if (enqueue) await enqueueIn(tx, kind, id)
    await tx.done
    return { before, after: next ?? before }
  }

  async enqueue(kind: SyncKind, id: string) {
    const db = await this.dbPromise
    const tx = db.transaction(['outbox'], 'readwrite') as unknown as WriteTx
    await enqueueIn(tx, kind, id)
    await tx.done
  }

  async enqueueAll() {
    const db = await this.dbPromise
    const kinds = Object.keys(STORE_OF) as SyncKind[]
    const tx = db.transaction([...kinds.map((k) => STORE_OF[k]), 'outbox'], 'readwrite')
    for (const kind of kinds) {
      for (const id of await tx.objectStore(STORE_OF[kind]).getAllKeys()) {
        await enqueueIn(tx, kind, id)
      }
    }
    await tx.done
  }

  async readOutbox(limit: number) {
    const all = await (await this.dbPromise).getAll('outbox', undefined, limit)
    return all.sort((a, b) => a.queuedAt - b.queuedAt)
  }

  async ackOutbox(entries: Pick<OutboxEntry, 'key' | 'n'>[]) {
    const db = await this.dbPromise
    const tx = db.transaction('outbox', 'readwrite')
    for (const e of entries) {
      const cur = await tx.store.get(e.key)
      if (cur && cur.n === e.n) await tx.store.delete(e.key)
    }
    await tx.done
  }

  async countOutbox() {
    return (await this.dbPromise).count('outbox')
  }

  async getMeta(key: string) {
    return (await this.dbPromise).get('meta', key)
  }

  async setMeta(key: string, value: string | null) {
    const db = await this.dbPromise
    if (value === null) await db.delete('meta', key)
    else await db.put('meta', value, key)
  }

  onLocalChange(listener: () => void) {
    return this.changes.subscribe(listener)
  }
}
