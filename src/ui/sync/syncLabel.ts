import type { SyncStatus } from '../../sync/engine'

export type SyncTone = 'ok' | 'busy' | 'warn'

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 上部バーのバッジに出す同期状態の短い文言 */
export function syncLabel(status: SyncStatus): { tone: SyncTone; text: string } {
  const pending = status.pending > 0 ? `（送信待ち ${status.pending}）` : ''
  switch (status.phase) {
    case 'syncing':
      return { tone: 'busy', text: '同期中…' }
    case 'offline':
      return { tone: 'warn', text: `オフライン${pending}` }
    case 'error':
      return { tone: 'warn', text: `同期エラー${pending}` }
    case 'unauthorized':
      return { tone: 'warn', text: '再ログインが必要' }
    case 'forbidden':
      return { tone: 'warn', text: '同期の対象外' }
    case 'quota':
      return { tone: 'warn', text: `容量上限${pending}` }
    case 'idle':
      if (status.pending > 0) return { tone: 'busy', text: `送信待ち ${status.pending}` }
      if (status.lastSyncedAt !== null) return { tone: 'ok', text: `同期済み ${hhmm(status.lastSyncedAt)}` }
      return { tone: 'busy', text: '同期を準備中' }
  }
}

/** ダイアログに出す詳しい説明 */
export function syncDetail(status: SyncStatus): string {
  switch (status.phase) {
    case 'syncing':
      return '同期しています。'
    case 'offline':
      return 'サーバーに接続できません。記録はこの端末に保存されていて、接続が戻ると自動で送られます。'
    case 'error':
      return `同期に失敗しました。しばらくしてから自動で再試行します。${status.error ? `（${status.error}）` : ''}`
    case 'unauthorized':
      return 'ログインの有効期限が切れました。もう一度ログインしてください。'
    case 'forbidden':
      return 'このアカウントは、この同期サーバーで同期できる対象になっていません。記録はこの端末に保存されています。'
    case 'quota':
      return '同期サーバーに置ける量の上限に達したため、新しい変更を送れません。記録はこの端末に保存されています。不要な記録を削除すると空きができます。'
    case 'idle':
      if (status.pending > 0) return `${status.pending} 件の変更を送る準備をしています。`
      return status.lastSyncedAt !== null
        ? `最後に同期した時刻: ${hhmm(status.lastSyncedAt)}`
        : '最初の同期を準備しています。'
  }
}
