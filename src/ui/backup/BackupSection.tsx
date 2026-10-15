import { useRef, useState } from 'react'
import { getStorage } from '../../storage'
import {
  BackupFormatError,
  backupFilename,
  buildBackup,
  parseBackup,
  type ImportCounts,
} from '../../storage/backup'
import { useAppStore } from '../../store/appStore'
import c from '../components/controls.module.css'
import { download } from '../download'

/** これより大きいファイルは読まない（同期の容量上限 32 MB より十分大きい） */
const MAX_FILE_BYTES = 64 * 1024 * 1024

type Message = { kind: 'ok' | 'error'; text: string }

export function importSummary(counts: ImportCounts, invalid: number): string {
  const parts = [
    `追加 ${counts.added} 件`,
    `更新 ${counts.updated} 件`,
    `変化なし ${counts.unchanged} 件`,
  ]
  let text = `読み込みました（${parts.join('・')}）。`
  if (counts.deletedHere > 0) {
    text += ` この端末で削除済みのため取り込まなかったもの ${counts.deletedHere} 件。`
  }
  if (invalid > 0) text += ` 形式が合わず読み込めなかったもの ${invalid} 件。`
  return text
}

/**
 * 全データ（バッチ・試薬・母液・スポイト・通電セッション）の書き出しと読み込み。
 * 読み込みは上書きではなくマージ（storage/backup.ts の規則）。
 */
export function BackupSection() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const exportAll = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const now = new Date()
      const backup = await buildBackup(getStorage(), now)
      download(backupFilename(now), 'application/json', JSON.stringify(backup, null, 2))
    } catch (e) {
      setMessage({ kind: 'error', text: `書き出せませんでした: ${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (file: File) => {
    setBusy(true)
    setMessage(null)
    try {
      if (file.size > MAX_FILE_BYTES) {
        throw new BackupFormatError('ファイルが大きすぎます（64 MB まで）。')
      }
      const { items, invalid } = parseBackup(await file.text())
      const counts = await getStorage().importRecords(items)
      await useAppStore.getState().reload()
      setMessage({ kind: 'ok', text: importSummary(counts, invalid) })
    } catch (e) {
      const text = e instanceof BackupFormatError ? e.message : String(e)
      setMessage({ kind: 'error', text: `読み込めませんでした: ${text}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className={c.subhead} style={{ marginTop: 34 }}>
        全データのバックアップ
      </div>
      <p className={c.subheadNote}>
        バッチ・試薬・母液・スポイト・通電セッションを 1 つの JSON にまとめて書き出します。
        読み込むと、この端末の記録とマージします（上書きはしません。同じ記録は新しい方が残り、
        この端末で削除した記録は戻りません）。ログイン中は、読み込んだ記録も同期されます。
      </p>
      <div className={c.row}>
        <button type="button" className={c.btnCancel} disabled={busy} onClick={() => void exportAll()}>
          全データを書き出す
        </button>
        <button
          type="button"
          className={c.btnCancel}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          バックアップを読み込む
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="バックアップファイル"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // 同じファイルをもう一度選べるように
            if (file) void importFile(file)
          }}
        />
      </div>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          style={{
            marginTop: 12,
            fontSize: 12,
            color: message.kind === 'error' ? 'var(--warn)' : 'var(--ink2)',
          }}
        >
          {message.text}
        </p>
      )}
    </>
  )
}
