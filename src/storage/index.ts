import type { StorageAdapter } from './StorageAdapter'
import { IndexedDbAdapter } from './indexedDbAdapter'
import { MemoryAdapter } from './memoryAdapter'

export type { StorageAdapter }

/** 実行環境に応じたアダプタ。jsdom（テスト）では IndexedDB がないのでメモリ実装 */
export function createStorage(): StorageAdapter {
  if (typeof indexedDB === 'undefined') return new MemoryAdapter()
  return new IndexedDbAdapter()
}
