import type { StorageAdapter } from './StorageAdapter'
import type { SyncStore } from './SyncStore'
import { IndexedDbAdapter } from './indexedDbAdapter'
import { MemoryAdapter } from './memoryAdapter'

export type { StorageAdapter, SyncStore }

/** アプリ向けの API と同期エンジン向けの API を同じ実装が兼ねる */
export type LocalStore = StorageAdapter & SyncStore

/** 実行環境に応じたアダプタ。jsdom（テスト）では IndexedDB がないのでメモリ実装 */
export function createStorage(): LocalStore {
  if (typeof indexedDB === 'undefined') return new MemoryAdapter()
  return new IndexedDbAdapter()
}

let instance: LocalStore | undefined

/** アプリ全体で共有するシングルトン（appStore・runStore・同期エンジンが同じ DB を見る） */
export function getStorage(): LocalStore {
  instance ??= createStorage()
  return instance
}
