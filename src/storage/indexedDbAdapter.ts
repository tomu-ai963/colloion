import { openDB, type DBSchema, type IDBPDatabase, type StoreNames } from 'idb'
import { newId } from '../core/id'
import type { SyncKind } from '../core/merge'
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

/** 送信待ちキューの1件。レコード本体は持たず、送信時点の最新版を読み直す */
export interface OutboxEntry {
  seq?: number
  kind: SyncKind
  id: string
  queuedAt: number
}

interface ColloionDB extends DBSchema {
  batches: { key: string; value: Batch }
  reagents: { key: string; value: Reagent }
  stocks: { key: string; value: Stock }
  pipettes: { key: string; value: Pipette }
  sessions: { key: string; value: Session }
  /** v3: 端末 ID・最終同期位置などのキーバリュー */
  meta: { key: string; value: string }
  /** v3: 同期の送信待ちキュー（Phase 3 Step 2 で使う） */
  outbox: { key: number; value: OutboxEntry }
}

type RecordStore = 'batches' | 'reagents' | 'stocks' | 'pipettes' | 'sessions'

const DEVICE_ID_KEY = 'deviceId'

export class IndexedDbAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBPDatabase<ColloionDB>>
  private deviceIdPromise: Promise<string> | undefined

  constructor(dbName = 'colloion') {
    this.dbPromise = openDB<ColloionDB>(dbName, 3, {
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
          db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true })

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

  /** 墓標の付いていないレコードだけ */
  private async listLive<S extends RecordStore>(store: S): Promise<ColloionDB[S]['value'][]> {
    const all = await (await this.dbPromise).getAll(store as StoreNames<ColloionDB>)
    return (all as ColloionDB[S]['value'][]).filter((v) => v.deletedAt === undefined)
  }

  /** 物理削除せず墓標を書く */
  private async tombstone(store: RecordStore, id: string) {
    const db = await this.dbPromise
    const tx = db.transaction(store, 'readwrite')
    const cur = await tx.store.get(id)
    if (cur) {
      const now = Date.now()
      await tx.store.put({ ...cur, deletedAt: now, updatedAt: now })
    }
    await tx.done
  }

  async listBatches() {
    const all = await this.listLive('batches')
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveBatch(batch: Batch) {
    await (await this.dbPromise).put('batches', batch)
  }
  async deleteBatch(id: string) {
    await this.tombstone('batches', id)
  }

  async listReagents() {
    return this.listLive('reagents')
  }
  async saveReagent(reagent: Reagent) {
    await (await this.dbPromise).put('reagents', reagent)
  }
  async deleteReagent(id: string) {
    await this.tombstone('reagents', id)
  }

  async listStocks() {
    const all = await this.listLive('stocks')
    return all.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
  }
  async saveStock(stock: Stock) {
    await (await this.dbPromise).put('stocks', stock)
  }
  async deleteStock(id: string) {
    await this.tombstone('stocks', id)
  }

  async listPipettes() {
    return this.listLive('pipettes')
  }
  async savePipette(pipette: Pipette) {
    await (await this.dbPromise).put('pipettes', pipette)
  }

  async listSessions() {
    const all = await this.listLive('sessions')
    return all.sort((a, b) => b.startedAt - a.startedAt)
  }
  async saveSession(session: Session) {
    await (await this.dbPromise).put('sessions', session)
  }
  async deleteSession(id: string) {
    await this.tombstone('sessions', id)
  }
}
