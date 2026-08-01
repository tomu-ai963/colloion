import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import type { StorageAdapter } from './StorageAdapter'

/** テスト・IndexedDB 非対応環境向けのインメモリ実装 */
export class MemoryAdapter implements StorageAdapter {
  private batches = new Map<string, Batch>()
  private reagents = new Map<string, Reagent>()
  private stocks = new Map<string, Stock>()
  private pipettes = new Map<string, Pipette>()
  private sessions = new Map<string, Session>()

  async listBatches() {
    return [...this.batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveBatch(batch: Batch) {
    this.batches.set(batch.id, structuredClone(batch))
  }
  async deleteBatch(id: string) {
    this.batches.delete(id)
  }

  async listReagents() {
    return [...this.reagents.values()]
  }
  async saveReagent(reagent: Reagent) {
    this.reagents.set(reagent.id, structuredClone(reagent))
  }
  async deleteReagent(id: string) {
    this.reagents.delete(id)
  }

  async listStocks() {
    return [...this.stocks.values()].sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
  }
  async saveStock(stock: Stock) {
    this.stocks.set(stock.id, structuredClone(stock))
  }
  async deleteStock(id: string) {
    this.stocks.delete(id)
  }

  async listPipettes() {
    return [...this.pipettes.values()]
  }
  async savePipette(pipette: Pipette) {
    this.pipettes.set(pipette.id, structuredClone(pipette))
  }

  async listSessions() {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt)
  }
  async saveSession(session: Session) {
    this.sessions.set(session.id, structuredClone(session))
  }
  async deleteSession(id: string) {
    this.sessions.delete(id)
  }
}
