import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { StorageAdapter } from './StorageAdapter'

interface ColloionDB extends DBSchema {
  batches: { key: string; value: Batch }
  reagents: { key: string; value: Reagent }
  stocks: { key: string; value: Stock }
  pipettes: { key: string; value: Pipette }
}

export class IndexedDbAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBPDatabase<ColloionDB>>

  constructor(dbName = 'colloion') {
    this.dbPromise = openDB<ColloionDB>(dbName, 1, {
      upgrade(db) {
        db.createObjectStore('batches', { keyPath: 'id' })
        db.createObjectStore('reagents', { keyPath: 'id' })
        db.createObjectStore('stocks', { keyPath: 'id' })
        db.createObjectStore('pipettes', { keyPath: 'id' })
      },
    })
  }

  async listBatches() {
    const all = await (await this.dbPromise).getAll('batches')
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveBatch(batch: Batch) {
    await (await this.dbPromise).put('batches', batch)
  }
  async deleteBatch(id: string) {
    await (await this.dbPromise).delete('batches', id)
  }

  async listReagents() {
    return (await this.dbPromise).getAll('reagents')
  }
  async saveReagent(reagent: Reagent) {
    await (await this.dbPromise).put('reagents', reagent)
  }
  async deleteReagent(id: string) {
    await (await this.dbPromise).delete('reagents', id)
  }

  async listStocks() {
    const all = await (await this.dbPromise).getAll('stocks')
    return all.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
  }
  async saveStock(stock: Stock) {
    await (await this.dbPromise).put('stocks', stock)
  }
  async deleteStock(id: string) {
    await (await this.dbPromise).delete('stocks', id)
  }

  async listPipettes() {
    return (await this.dbPromise).getAll('pipettes')
  }
  async savePipette(pipette: Pipette) {
    await (await this.dbPromise).put('pipettes', pipette)
  }
}
