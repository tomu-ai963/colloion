import type { StorageAdapter } from './StorageAdapter'
import { IndexedDbAdapter } from './indexedDbAdapter'
import { MemoryAdapter } from './memoryAdapter'

export type { StorageAdapter }

/** 実行環境に応じたアダプタ。jsdom（テスト）では IndexedDB がないのでメモリ実装 */
export function createStorage(): StorageAdapter {
  if (typeof indexedDB === 'undefined') return new MemoryAdapter()
  return new IndexedDbAdapter()
}

let instance: StorageAdapter | undefined

/** アプリ全体で共有するシングルトン（appStore と runStore が同じ DB を見る） */
export function getStorage(): StorageAdapter {
  instance ??= createStorage()
  return instance
}
