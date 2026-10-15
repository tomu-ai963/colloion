import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import type { ImportCounts, ImportItem } from './backup'

/**
 * 永続化の抽象。この端末の IndexedDB が正本で、Phase 3 の同期
 * （Cloudflare Workers + D1）はこの上に送信待ちキューを重ねて行う。
 *
 * - list* は削除の墓標（deletedAt）が付いたレコードを返さない
 * - delete* は物理削除せず墓標を書く（他端末に削除を伝えるため）
 */
export interface StorageAdapter {
  /** この端末の ID。初回に生成して保存し、以後は同じ値を返す */
  getDeviceId(): Promise<string>

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

  listSessions(): Promise<Session[]>
  saveSession(session: Session): Promise<void>
  deleteSession(id: string): Promise<void>

  /**
   * バックアップの読み込み。既存のレコードとは resolveImport の規則で突き合わせ、
   * 変わったものだけを書いて送信待ちに積む（全件を1トランザクションで）
   */
  importRecords(items: ImportItem[]): Promise<ImportCounts>
}
