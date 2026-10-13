import { newId } from '../core/id'
import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import type { StorageAdapter } from './StorageAdapter'

type Tombstonable = { deletedAt?: number; updatedAt: number }

const live = <T extends Tombstonable>(map: Map<string, T>): T[] =>
  [...map.values()].filter((v) => v.deletedAt === undefined)

function tombstone<T extends Tombstonable>(map: Map<string, T>, id: string): void {
  const cur = map.get(id)
  if (!cur) return
  const now = Date.now()
  map.set(id, { ...cur, deletedAt: now, updatedAt: now })
}

/** テスト・IndexedDB 非対応環境向けのインメモリ実装 */
export class MemoryAdapter implements StorageAdapter {
  private deviceId = newId()
  private batches = new Map<string, Batch>()
  private reagents = new Map<string, Reagent>()
  private stocks = new Map<string, Stock>()
  private pipettes = new Map<string, Pipette>()
  private sessions = new Map<string, Session>()

  async getDeviceId() {
    return this.deviceId
  }

  async listBatches() {
    return live(this.batches).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveBatch(batch: Batch) {
    this.batches.set(batch.id, structuredClone(batch))
  }
  async deleteBatch(id: string) {
    tombstone(this.batches, id)
  }

  async listReagents() {
    return live(this.reagents)
  }
  async saveReagent(reagent: Reagent) {
    this.reagents.set(reagent.id, structuredClone(reagent))
  }
  async deleteReagent(id: string) {
    tombstone(this.reagents, id)
  }

  async listStocks() {
    return live(this.stocks).sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
  }
  async saveStock(stock: Stock) {
    this.stocks.set(stock.id, structuredClone(stock))
  }
  async deleteStock(id: string) {
    tombstone(this.stocks, id)
  }

  async listPipettes() {
    return live(this.pipettes)
  }
  async savePipette(pipette: Pipette) {
    this.pipettes.set(pipette.id, structuredClone(pipette))
  }

  async listSessions() {
    return live(this.sessions).sort((a, b) => b.startedAt - a.startedAt)
  }
  async saveSession(session: Session) {
    this.sessions.set(session.id, structuredClone(session))
  }
  async deleteSession(id: string) {
    tombstone(this.sessions, id)
  }
}
