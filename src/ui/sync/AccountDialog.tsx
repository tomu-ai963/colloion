import { useEffect, useState, type FormEvent } from 'react'
import { AuthApiError } from '../../auth/client'
import { useAuthStore } from '../../auth/store'
import { syncNow, useSyncStore } from '../../sync'
import s from '../App.module.css'
import c from './sync.module.css'
import { syncDetail } from './syncLabel'

/** コードの再送を許すまでの秒数 */
const RESEND_COOLDOWN_SEC = 60
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const messageOf = (e: unknown): string =>
  e instanceof AuthApiError ? e.message : 'サーバーに接続できません。通信状態を確かめてください'

/** ログイン（メール → コード）とログイン中の同期状態・ログアウト */
export function AccountDialog({ onClose }: { onClose: () => void }) {
  const status = useAuthStore((st) => st.status)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div className={s.modal}>
        {status === 'signedIn' ? <SignedIn onClose={onClose} /> : <SignIn onClose={onClose} />}
      </div>
    </div>
  )
}

function SignIn({ onClose }: { onClose: () => void }) {
  const expired = useAuthStore((st) => st.expired)
  const previousEmail = useAuthStore((st) => st.previousEmail)
  const sendCode = useAuthStore((st) => st.sendCode)
  const verifyCode = useAuthStore((st) => st.verifyCode)

  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(previousEmail ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const trimmed = email.trim()
  const otherAccount =
    previousEmail !== null && trimmed !== '' && trimmed.toLowerCase() !== previousEmail.toLowerCase()

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!EMAIL_RE.test(trimmed)) {
      setError('メールアドレスの形式が正しくありません')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await sendCode(trimmed)
      setStep('code')
      setCode('')
      setCooldown(RESEND_COOLDOWN_SEC)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const verify = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await verifyCode(trimmed, code)
      onClose()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 id="account-title">同期にログイン</h2>
      {expired && (
        <p className={c.caution} role="alert">
          ログインの有効期限が切れました。もう一度ログインしてください。送信待ちの記録はこの端末に残っていて、
          同じアカウントでログインし直すと続きから送られます。
        </p>
      )}

      {step === 'email' ? (
        <form onSubmit={(e) => void send(e)}>
          <p className={c.note}>
            ログインすると、記録がアカウントに保存され、同じアカウントでログインした他の端末と同期されます。
            ログインしなくても、記録はこの端末に保存されます。
          </p>
          <div className={c.field}>
            <label htmlFor="account-email">メールアドレス</label>
            <input
              id="account-email"
              className={c.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {otherAccount && (
            <p className={c.caution} role="alert">
              この端末は前回 <b>{previousEmail}</b> で同期していました。別のアカウントでログインすると、
              この端末にある記録はそのアカウントにも送られます。
            </p>
          )}
          {error && (
            <p className={c.error} role="alert">
              {error}
            </p>
          )}
          <div className={s.modalBtns}>
            <button type="submit" className={s.btnSolid} disabled={busy}>
              {busy ? '送信中…' : 'ログイン用のコードを送る'}
            </button>
            <button type="button" className={s.btnGhost} onClick={onClose}>
              閉じる
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => void verify(e)}>
          <p className={c.info} role="status">
            <b>{trimmed}</b> に 6 桁のコードを送りました。数分で無効になります。
            届かないときは迷惑メールのフォルダも確かめてください。
          </p>
          <div className={c.field}>
            <label htmlFor="account-code">コード</label>
            <input
              id="account-code"
              className={c.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          {error && (
            <p className={c.error} role="alert">
              {error}
            </p>
          )}
          <div className={s.modalBtns}>
            <button type="submit" className={s.btnSolid} disabled={busy || code.length !== 6}>
              {busy ? '確認中…' : 'ログイン'}
            </button>
            <button type="button" className={s.btnGhost} onClick={onClose}>
              閉じる
            </button>
          </div>
          <p className={c.note}>
            <button
              type="button"
              className={c.linkBtn}
              disabled={busy || cooldown > 0}
              onClick={() => void send()}
            >
              {cooldown > 0 ? `コードを再送（${cooldown} 秒後）` : 'コードを再送'}
            </button>
            {'　'}
            <button
              type="button"
              className={c.linkBtn}
              disabled={busy}
              onClick={() => {
                setStep('email')
                setError(null)
              }}
            >
              メールアドレスを変える
            </button>
          </p>
        </form>
      )}
    </>
  )
}

function SignedIn({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((st) => st.user)
  const signOut = useAuthStore((st) => st.signOut)
  const status = useSyncStore((st) => st.status)
  const [busy, setBusy] = useState(false)

  return (
    <>
      <h2 id="account-title">同期</h2>
      <dl className={c.rows}>
        <div>
          <dt>アカウント</dt>
          <dd>{user?.email}</dd>
        </div>
        <div>
          <dt>送信待ち</dt>
          <dd>{status.pending} 件</dd>
        </div>
      </dl>
      <p className={status.phase === 'idle' || status.phase === 'syncing' ? c.note : c.caution} role="status">
        {syncDetail(status)}
      </p>
      <div className={s.modalBtns}>
        <button
          type="button"
          className={s.btnSolid}
          disabled={busy || status.phase === 'syncing'}
          onClick={() => {
            setBusy(true)
            void syncNow().finally(() => setBusy(false))
          }}
        >
          今すぐ同期
        </button>
        <button
          type="button"
          className={s.btnGhost}
          onClick={() => {
            void signOut().catch(() => {})
            onClose()
          }}
        >
          ログアウト
        </button>
        <button type="button" className={s.btnGhost} onClick={onClose}>
          閉じる
        </button>
      </div>
      <p className={c.note}>
        ログアウトしても、この端末の記録は消えません。送信待ちの記録は、次に同じアカウントでログインしたときに送られます。
      </p>
    </>
  )
}
