/**
 * 認証クライアント（Neon Managed Better Auth を同一オリジンの /api/auth/* 経由で使う）。
 *
 * Neon SDK（@neondatabase/neon-js）は使わない。bitane で実機確認した問題があるため:
 *   - 他タブへの通知が localStorage 経由で、セッショントークンが載る
 *   - /token が getSession のキャッシュで短絡し、トークンが取れない
 * 素の fetch で Better Auth のエンドポイントを叩く。
 *
 * - セッション: HttpOnly の Cookie（JavaScript からは触れない。localStorage には何も置かない）
 * - アクセストークン: GET /token の JWT（15 分）。メモリにだけ持ち、期限の 60 秒前に取り直す
 */

const BASE = '/api/auth'
/** 期限のこの時間前になったら取り直す */
const TOKEN_REFRESH_MARGIN_MS = 60_000

export interface AuthUser {
  id: string
  email: string
  name?: string
}

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(authErrorMessage(status, code))
    this.name = 'AuthApiError'
  }
}

/** 画面に出すメッセージ（Better Auth のエラーコードから） */
function authErrorMessage(status: number, code: string | null): string {
  switch (code) {
    case 'INVALID_OTP':
      return 'コードが正しくありません'
    case 'OTP_EXPIRED':
      return 'コードの有効期限が切れました。もう一度送ってください'
    case 'TOO_MANY_ATTEMPTS':
      return '試行回数が上限に達しました。もう一度コードを送ってください'
    case 'INVALID_EMAIL':
      return 'メールアドレスの形式が正しくありません'
  }
  if (status === 429) return 'リクエストが多すぎます。しばらく待ってから試してください'
  if (status === 503) return '同期サーバーの認証が設定されていません'
  return `認証サーバーがエラーを返しました（${status}）`
}

async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', ...init.headers },
  })
  if (!res.ok) {
    let code: string | null = null
    try {
      code = ((await res.json()) as { code?: string }).code ?? null
    } catch {
      // 本文が JSON でなければコード無し
    }
    throw new AuthApiError(res.status, code)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

const postJson = <T>(path: string, body: unknown) =>
  authFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** ログイン用のコードをメールで送る（アカウントが無ければサインイン時に作られる） */
export async function sendSignInOtp(email: string): Promise<void> {
  await postJson('/email-otp/send-verification-otp', { email: email.trim(), type: 'sign-in' })
}

/** コードでサインインする。成功するとセッション Cookie が立つ */
export async function signInWithOtp(email: string, otp: string): Promise<AuthUser> {
  const res = await postJson<{ user?: AuthUser }>('/sign-in/email-otp', {
    email: email.trim(),
    otp: otp.trim(),
  })
  clearAccessToken()
  if (res?.user) return res.user
  const session = await getSession()
  if (!session) throw new AuthApiError(401, null)
  return session
}

/** 現在のセッションのユーザー。未ログインなら null */
export async function getSession(): Promise<AuthUser | null> {
  const res = await authFetch<{ user?: AuthUser } | null>('/get-session')
  return res?.user ?? null
}

export async function signOut(): Promise<void> {
  clearAccessToken()
  await postJson('/sign-out', {})
}

let cached: { token: string; expMs: number } | null = null
let inflight: Promise<string | null> | null = null

/** JWT の exp（ミリ秒）。読めなければ 0（＝すぐ取り直す） */
export function jwtExpMs(token: string): number {
  try {
    const payload = token.split('.')[1]!
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const exp = (JSON.parse(json) as { exp?: unknown }).exp
    return typeof exp === 'number' ? exp * 1000 : 0
  } catch {
    return 0
  }
}

/**
 * 同期 API 用のアクセストークン。未ログイン（セッション切れ）なら null。
 * 同時に呼ばれても /token は 1 回だけ叩く。
 */
export function getAccessToken(nowMs = Date.now()): Promise<string | null> {
  if (cached && cached.expMs - nowMs > TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(cached.token)
  inflight ??= (async () => {
    try {
      const res = await authFetch<{ token?: string }>('/token')
      if (!res?.token) return null
      cached = { token: res.token, expMs: jwtExpMs(res.token) }
      return res.token
    } catch (e) {
      if (e instanceof AuthApiError && e.status === 401) return null
      throw e
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function clearAccessToken(): void {
  cached = null
}
