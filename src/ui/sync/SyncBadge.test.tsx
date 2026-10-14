import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthApiError } from '../../auth/client'
import { useAuthStore, type AuthState } from '../../auth/store'
import { useSyncStore, type SyncState } from '../../sync'
import type { SyncStatus } from '../../sync/engine'
import { SyncBadge } from './SyncBadge'
import { syncLabel } from './syncLabel'

let initialAuth: AuthState
let initialSync: SyncState

beforeAll(() => {
  initialAuth = useAuthStore.getState()
  initialSync = useSyncStore.getState()
})
afterEach(() => {
  cleanup()
  useAuthStore.setState(initialAuth, true)
  useSyncStore.setState(initialSync, true)
  vi.useRealTimers()
})

const status = (patch: Partial<SyncStatus>): SyncStatus => ({
  phase: 'idle',
  pending: 0,
  lastSyncedAt: null,
  error: null,
  ...patch,
})

describe('SyncBadge: 表示の切り替え', () => {
  it('同期サーバーが無い配信（GitHub Pages 等）では何も出さない', () => {
    useAuthStore.setState({ status: 'unavailable' })
    const { container } = render(<SyncBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it('未ログインなら「同期にログイン」、セッション切れなら「再ログインが必要」', () => {
    useAuthStore.setState({ status: 'signedOut' })
    const { rerender } = render(<SyncBadge />)
    expect(screen.getByRole('button', { name: '同期にログイン' })).toBeInTheDocument()
    act(() => useAuthStore.setState({ expired: true }))
    rerender(<SyncBadge />)
    expect(screen.getByRole('button', { name: '再ログインが必要' })).toBeInTheDocument()
  })

  it('ログイン中は同期の状態を出す', () => {
    useAuthStore.setState({ status: 'signedIn', user: { id: 'u', email: 'a@example.com' } })
    useSyncStore.setState({ status: status({ phase: 'offline', pending: 3 }) })
    render(<SyncBadge />)
    expect(screen.getByRole('button', { name: '同期の状態: オフライン（送信待ち 3）' })).toBeInTheDocument()
  })

  it('他端末の変更を反映したら短く知らせる', () => {
    vi.useFakeTimers()
    useAuthStore.setState({ status: 'signedIn', user: { id: 'u', email: 'a@example.com' } })
    render(<SyncBadge />)
    act(() => useSyncStore.setState({ lastAppliedAt: Date.now() }))
    expect(screen.getByRole('status')).toHaveTextContent('他の端末の変更を反映しました')
    act(() => vi.advanceTimersByTime(4_100))
    expect(screen.queryByText('他の端末の変更を反映しました')).not.toBeInTheDocument()
  })
})

describe('AccountDialog: ログイン', () => {
  const user = { id: 'u1', email: 'a@example.com' }

  function setup(extra: Partial<AuthState> = {}) {
    const sendCode = vi.fn(async () => {})
    const verifyCode = vi.fn(async () => {
      useAuthStore.setState({ status: 'signedIn', user })
    })
    useAuthStore.setState({ status: 'signedOut', sendCode, verifyCode, ...extra })
    render(<SyncBadge />)
    return { sendCode, verifyCode, u: userEvent.setup() }
  }

  it('メール → コードの 2 段階でログインし、ダイアログが閉じる', async () => {
    const { sendCode, verifyCode, u } = setup()
    await u.click(screen.getByRole('button', { name: '同期にログイン' }))
    await u.type(screen.getByLabelText('メールアドレス'), ' a@example.com ')
    await u.click(screen.getByRole('button', { name: 'ログイン用のコードを送る' }))
    expect(sendCode).toHaveBeenCalledWith('a@example.com')
    expect(screen.getByRole('status')).toHaveTextContent('a@example.com に 6 桁のコードを送りました')

    const login = screen.getByRole('button', { name: 'ログイン' })
    await u.type(screen.getByLabelText('コード'), '12a34') // 数字以外は入らない
    expect(login).toBeDisabled()
    await u.type(screen.getByLabelText('コード'), '56')
    expect(login).toBeEnabled()
    await u.click(login)
    expect(verifyCode).toHaveBeenCalledWith('a@example.com', '123456')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /同期の状態/ })).toBeInTheDocument()
  })

  it('形式の違うメールは送らない', async () => {
    const { sendCode, u } = setup()
    await u.click(screen.getByRole('button', { name: '同期にログイン' }))
    await u.type(screen.getByLabelText('メールアドレス'), 'not-an-email')
    await u.click(screen.getByRole('button', { name: 'ログイン用のコードを送る' }))
    expect(sendCode).not.toHaveBeenCalled()
  })

  it('コード違いはサーバーのエラーを日本語で出し、ダイアログは開いたまま', async () => {
    const { verifyCode, u } = setup()
    verifyCode.mockRejectedValueOnce(new AuthApiError(400, 'INVALID_OTP'))
    await u.click(screen.getByRole('button', { name: '同期にログイン' }))
    await u.type(screen.getByLabelText('メールアドレス'), 'a@example.com')
    await u.click(screen.getByRole('button', { name: 'ログイン用のコードを送る' }))
    await u.type(screen.getByLabelText('コード'), '000000')
    await u.click(screen.getByRole('button', { name: 'ログイン' }))
    expect(screen.getByRole('alert')).toHaveTextContent('コードが正しくありません')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('前回と別のアカウントでログインしようとすると注意を出す', async () => {
    const { u } = setup({ previousEmail: 'old@example.com' })
    await u.click(screen.getByRole('button', { name: '同期にログイン' }))
    const input = screen.getByLabelText('メールアドレス')
    expect(input).toHaveValue('old@example.com') // 前回のアドレスを入れておく
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await u.clear(input)
    await u.type(input, 'new@example.com')
    expect(screen.getByRole('alert')).toHaveTextContent('この端末は前回 old@example.com で同期していました')
  })

  it('コードの再送は 60 秒あける', async () => {
    const { sendCode, u } = setup()
    await u.click(screen.getByRole('button', { name: '同期にログイン' }))
    await u.type(screen.getByLabelText('メールアドレス'), 'a@example.com')
    await u.click(screen.getByRole('button', { name: 'ログイン用のコードを送る' }))
    expect(screen.getByRole('button', { name: /コードを再送（\d+ 秒後）/ })).toBeDisabled()
    expect(sendCode).toHaveBeenCalledTimes(1)
  })
})

describe('AccountDialog: ログイン中', () => {
  it('アカウントと送信待ちを出し、ログアウトできる', async () => {
    const signOut = vi.fn(async () => {
      useAuthStore.setState({ status: 'signedOut', user: null })
    })
    useAuthStore.setState({ status: 'signedIn', user: { id: 'u', email: 'a@example.com' }, signOut })
    useSyncStore.setState({ status: status({ pending: 2 }) })
    const u = userEvent.setup()
    render(<SyncBadge />)
    await u.click(screen.getByRole('button', { name: /同期の状態/ }))
    expect(screen.getByText('a@example.com')).toBeInTheDocument()
    expect(screen.getByText('2 件')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'ログアウト' }))
    expect(signOut).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '同期にログイン' })).toBeInTheDocument()
  })

  it('Escape で閉じる', async () => {
    useAuthStore.setState({ status: 'signedIn', user: { id: 'u', email: 'a@example.com' } })
    const u = userEvent.setup()
    render(<SyncBadge />)
    await u.click(screen.getByRole('button', { name: /同期の状態/ }))
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('syncLabel', () => {
  it('状態ごとの文言', () => {
    const at = new Date(2026, 9, 13, 9, 5).getTime()
    expect(syncLabel(status({ lastSyncedAt: at }))).toEqual({ tone: 'ok', text: '同期済み 9:05' })
    expect(syncLabel(status({ pending: 4 }))).toEqual({ tone: 'busy', text: '送信待ち 4' })
    expect(syncLabel(status({ phase: 'syncing' })).text).toBe('同期中…')
    expect(syncLabel(status({ phase: 'error', pending: 1 }))).toEqual({
      tone: 'warn',
      text: '同期エラー（送信待ち 1）',
    })
    expect(syncLabel(status({ phase: 'unauthorized' })).text).toBe('再ログインが必要')
    expect(syncLabel(status({ phase: 'forbidden' }))).toEqual({ tone: 'warn', text: '同期の対象外' })
    expect(syncLabel(status({ phase: 'quota', pending: 2 }))).toEqual({
      tone: 'warn',
      text: '容量上限（送信待ち 2）',
    })
  })
})

describe('セッション切れ（同期で 401）', () => {
  it('ログアウト状態に戻して再ログインを促す', () => {
    useAuthStore.setState({ status: 'signedIn', user: { id: 'u', email: 'a@example.com' } })
    useSyncStore.setState({ status: status({ phase: 'unauthorized', pending: 1 }) })
    expect(useAuthStore.getState()).toMatchObject({ status: 'signedOut', user: null, expired: true })
  })
})
