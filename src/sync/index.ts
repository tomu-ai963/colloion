import { create } from 'zustand'
import { getStorage } from '../storage'
import { useAppStore } from '../store/appStore'
import { SyncEngine, type SyncStatus } from './engine'
import type { SyncTransport } from './protocol'

/** 同期状態（UI 表示用）。ログインしていなければ disabled */
export interface SyncState {
  enabled: boolean
  status: SyncStatus
}

export const useSyncStore = create<SyncState>(() => ({
  enabled: false,
  status: { phase: 'idle', pending: 0, lastSyncedAt: null, error: null },
}))

let engine: SyncEngine | null = null

/**
 * ログイン後に呼ぶ。transport は認証付きの HTTP 実装（Step 3〜4）。
 * サーバー由来の変更が入ったらアプリの保存済みデータを読み直す。
 */
export async function startSync(transport: SyncTransport, userId: string): Promise<SyncEngine> {
  stopSync()
  const e = new SyncEngine(getStorage(), transport, {
    onApplied: () => void useAppStore.getState().reload(),
    onStatus: (status) => useSyncStore.setState({ status }),
  })
  engine = e
  await e.attach(userId)
  useSyncStore.setState({ enabled: true })
  e.start()
  return e
}

/** ログアウト時。ローカルのデータと送信待ちは残す（再ログインで続きから送る） */
export function stopSync(): void {
  engine?.stop()
  engine = null
  useSyncStore.setState({ enabled: false })
}

/** 「今すぐ同期」ボタン用 */
export function syncNow(): Promise<unknown> {
  return engine ? engine.syncOnce().catch(() => {}) : Promise.resolve()
}
