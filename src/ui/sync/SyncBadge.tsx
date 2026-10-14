import { useEffect, useState } from 'react'
import { useAuthStore } from '../../auth/store'
import { useSyncStore } from '../../sync'
import s from '../App.module.css'
import { AccountDialog } from './AccountDialog'
import c from './sync.module.css'
import { syncLabel } from './syncLabel'

/** 他端末の変更を反映したお知らせを出しておく時間 */
const TOAST_MS = 4_000

/**
 * 上部バーの同期の入口。同期サーバーが無い環境（vite 単体の開発サーバー等）では何も出さない。
 * 未ログインなら「同期にログイン」、ログイン中は同期状態のバッジ。押すとアカウントのダイアログ。
 */
export function SyncBadge() {
  const authStatus = useAuthStore((st) => st.status)
  const expired = useAuthStore((st) => st.expired)
  const status = useSyncStore((st) => st.status)
  const lastAppliedAt = useSyncStore((st) => st.lastAppliedAt)
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState(false)

  useEffect(() => {
    if (lastAppliedAt === null) return
    setToast(true)
    const t = setTimeout(() => setToast(false), TOAST_MS)
    return () => clearTimeout(t)
  }, [lastAppliedAt])

  if (authStatus === 'unknown' || authStatus === 'unavailable') return null

  let button
  if (authStatus === 'signedOut') {
    button = (
      <button type="button" className={expired ? c.badgeWarn : s.btnGhost} onClick={() => setOpen(true)}>
        {expired ? '再ログインが必要' : '同期にログイン'}
      </button>
    )
  } else {
    const label = syncLabel(status)
    button = (
      <button
        type="button"
        className={label.tone === 'warn' ? c.badgeWarn : c.badge}
        aria-label={`同期の状態: ${label.text}`}
        onClick={() => setOpen(true)}
      >
        <span className={`${c.dot} ${c[label.tone]}`} aria-hidden="true" />
        {label.text}
      </button>
    )
  }

  return (
    <>
      {button}
      {toast && (
        <div className={c.toast} role="status">
          他の端末の変更を反映しました
        </div>
      )}
      {open && <AccountDialog onClose={() => setOpen(false)} />}
    </>
  )
}
