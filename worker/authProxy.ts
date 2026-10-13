/**
 * /api/auth/* — Neon Managed Better Auth へのリバースプロキシ。
 *
 * なぜ中継するのか: Neon のセッション Cookie は別サイトから使うと third-party 扱いになり、
 * Safari（ITP）や Firefox で落ちる。フロント・API・認証を同一オリジンに揃えて first-party にする。
 * 書き換えの規則は bitane（src/routes/auth-proxy.ts）で実機確認済みのものに合わせている:
 *   1. Origin / Referer / Cookie / Sec-Fetch-* を素通しする（Better Auth の CSRF 防御が使う）
 *   2. redirect: 'manual'（追従すると Set-Cookie を失う）
 *   3. 上流ホストを指す Location は自オリジンの相対パスへ
 *   4. Set-Cookie は SameSite=Lax に、Partitioned を除去（同一サイトなので不要）
 *   5. Cache-Control: no-store（ここを通るのはセッションとトークンそのもの）
 *
 * bitane と違い、転送するのは colloion が使うエンドポイントだけ（許可リスト）。
 * パスワードでのサインアップなど、使っていない経路は外から叩けないようにする。
 */

import type { D1Like } from './db'
import { enforceRateLimit } from './rateLimit'

/** 中継する経路（サブパス → メソッド） */
const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/email-otp/send-verification-otp': 'POST',
  '/sign-in/email-otp': 'POST',
  '/get-session': 'GET',
  '/token': 'GET',
  '/sign-out': 'POST',
}

/** OTP の送信: 同じメール宛て 5 回/時・同じ IP から 20 回/時 */
const OTP_SEND_LIMIT = { email: 5, ip: 20 }
/** OTP での サインイン試行: 同じ IP から 30 回/時（コードごとの試行回数は Better Auth 側でも制限される） */
const OTP_VERIFY_IP_LIMIT = 30

const FORWARD_REQUEST_HEADERS = [
  'origin',
  'referer',
  'cookie',
  'content-type',
  'accept',
  'accept-language',
  'user-agent',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]

/** 認証 API のリクエスト本文は小さい。これを超えるものは想定外 */
const MAX_BODY_BYTES = 16 * 1024

/**
 * 中継しないレスポンスヘッダー。access-control-* は、上流が返した許可を
 * そのまま返すと第三者オリジンからの読み取りを許しかねないため落とす。
 */
const isDroppedResponseHeader = (name: string): boolean =>
  name === 'set-cookie' ||
  name === 'content-encoding' ||
  name === 'content-length' ||
  name === 'transfer-encoding' ||
  name === 'connection' ||
  name === 'cache-control' ||
  name.startsWith('access-control-')

/** Set-Cookie を同一サイト前提に書き換える。Secure / HttpOnly / __Secure- の要件は維持する */
export function rewriteSetCookie(cookie: string): string {
  const segments = cookie
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length === 0) return cookie
  const out = [segments[0]!]
  let sawSameSite = false
  for (const seg of segments.slice(1)) {
    const lower = seg.toLowerCase()
    if (lower === 'partitioned') continue
    if (lower.startsWith('samesite=')) {
      out.push('SameSite=Lax')
      sawSameSite = true
      continue
    }
    out.push(seg)
  }
  if (!sawSameSite) out.push('SameSite=Lax')
  return out.join('; ')
}

/** 上流オリジンで始まる Location だけを自オリジンの相対パスへ直す */
export function rewriteLocation(location: string, upstreamOrigin: string): string {
  if (!location.startsWith(upstreamOrigin)) return location
  return location.slice(upstreamOrigin.length) || '/'
}

export class AuthProxyError extends Error {
  constructor(readonly status: 400 | 404 | 405 | 503) {
    super(`auth proxy: ${status}`)
    this.name = 'AuthProxyError'
  }
}

export interface AuthProxyEnv {
  DB: D1Like
  NEON_AUTH_BASE_URL?: string
}

export async function proxyAuth(
  request: Request,
  env: AuthProxyEnv,
  subPath: string,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  const base = env.NEON_AUTH_BASE_URL?.replace(/\/+$/, '')
  if (!base) throw new AuthProxyError(503)
  const method = ROUTES[subPath]
  if (!method) throw new AuthProxyError(404)
  if (request.method !== method) throw new AuthProxyError(405)
  const upstreamOrigin = new URL(base).origin

  let body: string | undefined
  if (method === 'POST') {
    body = await request.text()
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new AuthProxyError(400)
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if (subPath === '/email-otp/send-verification-otp') {
    const email = emailOf(body)
    if (email) await enforceRateLimit(env.DB, 'otp_email', email, OTP_SEND_LIMIT.email)
    await enforceRateLimit(env.DB, 'otp_send_ip', ip, OTP_SEND_LIMIT.ip)
  } else if (subPath === '/sign-in/email-otp') {
    await enforceRateLimit(env.DB, 'otp_verify_ip', ip, OTP_VERIFY_IP_LIMIT)
  }

  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  const url = new URL(request.url)
  const upstream = await doFetch(`${base}${subPath}${url.search}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  })

  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    if (!isDroppedResponseHeader(name.toLowerCase())) out.set(name, value)
  }
  out.set('Cache-Control', 'no-store')
  const location = upstream.headers.get('location')
  if (location) out.set('Location', rewriteLocation(location, upstreamOrigin))
  for (const cookie of upstream.headers.getSetCookie()) out.append('Set-Cookie', rewriteSetCookie(cookie))

  return new Response(upstream.body, { status: upstream.status, headers: out })
}

/** レート制限のキーにするメールアドレス（小文字・前後空白除去）。形が違えば null */
function emailOf(body: string | undefined): string | null {
  try {
    const parsed = JSON.parse(body ?? '') as { email?: unknown }
    return typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : null
  } catch {
    return null
  }
}
