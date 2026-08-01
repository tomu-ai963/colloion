import type { Batch, Pipette, Reagent, Stock } from '../core/model'

/**
 * 永続化の抽象。Phase 1 は IndexedDB のみだが、
 * Phase 3 の同期（Cloudflare Workers + D1）で差し替えられるようにしておく。
 */
export interface StorageAdapter {
  listBatches(): Promise<Batch[]>
  saveBatch(batch: Batch): Promise<void>
  deleteBatch(id: string): Promise<void>

  listReagents(): Promise<Reagent[]>
  saveReagent(reagent: Reagent): Promise<void>
  deleteReagent(id: string): Promise<void>

  listStocks(): Promise<Stock[]>
  saveStock(stock: Stock): Promise<void>
  deleteStock(id: string): Promise<void>

  listPipettes(): Promise<Pipette[]>
  savePipette(pipette: Pipette): Promise<void>
}
