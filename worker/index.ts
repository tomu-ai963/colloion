/**
 * colloion Worker（Phase 3）。
 *
 * フロント（dist/）は同じ Worker の assets から配信し、API は /api/* に置く。
 * 同じオリジンになるので、本番では CORS も第三者 Cookie（Safari ITP）の問題も起きない。
 * ALLOWED_ORIGINS は vite の開発サーバー（別ポート）から叩くとき用。
 *
 *   GET  /api/health
 *   GET  /api/sync/pull?since=<rev>
 *   POST /api/sync/push   { changes: PushChange[] }（容量上限を超えるなら 507）
 *   *    /api/auth/*      Neon Auth への中継（worker/authProxy.ts。同一オリジン専用で CORS は付けない）
 *   POST /api/webhooks/neon-auth  Neon Auth の webhook。ログインコードを日本語のメールで送る（worker/authWebhook.ts）
 */

import { MAX_PUSH_BYTES, PULL_PAGE_LIMIT } from '../src/sync/protocol'
import {
  AuthUnavailable,
  authConfigFromBaseUrl,
  authenticate,
  Unauthorized,
  type AuthConfig,
} from './auth'
import { isAllowed, parseAllowedUsers } from './access'
import { AuthProxyError, proxyAuth } from './authProxy'
import { handleAuthWebhook } from './authWebhook'
import { readText } from './body'
import type { D1Like } from './db'
import { enforceRateLimit, RateLimited } from './rateLimit'
import { pull, push, QuotaExceeded, type Quota } from './sync'
import { BadRequest, parsePushBody, parseSince } from './validate'

export interface Env {
  DB: D1Like
  /**
   * Neon Managed Better Auth の URL。未設定なら同期 API・認証は 503。
   * 本番は `wrangler secret put`、ローカルは .dev.vars で渡す（wrangler.jsonc の vars には書かない）。
   * 秘密鍵ではないが、中継しているのでブラウザには見えず、公開リポジトリに載せると
   * Neon の認証 API を直接叩く入口（中継のレート制限を迂回できる）を晒すことになる
   */
  NEON_AUTH_BASE_URL?: string
  /**
   * 同期を使えるユーザー ID（カンマ区切り。`*` で全員）。未設定なら同期 API は 503（worker/access.ts）。
   * 本番は `wrangler secret put`、ローカルは .dev.vars
   */
  SYNC_ALLOWED_USER_IDS?: string
  /**
   * ログインコードのメールを送る Resend の API キー（送信のみ）。未設定なら webhook は 503。
   * 本番は `wrangler secret put`、ローカルは .dev.vars（wrangler.jsonc の vars には書かない）
   */
  RESEND_API_KEY?: string
  /** ログインコードのメールの差出人。秘密ではないので wrangler.jsonc の vars */
  MAIL_FROM?: string
  /** CORS を許すオリジン（カンマ区切り）。本番は同一オリジンなので空 */
  ALLOWED_ORIGINS?: string
  ASSETS?: { fetch(request: Request): Promise<Response> }
}

/** テストで認証設定を差し替えるための口（本番は NEON_AUTH_BASE_URL から作る） */
export interface Deps {
  authConfig?: AuthConfig
  /** 認証の中継が上流（Neon）を叩くとき・webhook が Resend を叩くときの fetch */
  fetch?: typeof fetch
  /** 容量上限（テストで小さくする用。本番は DEFAULT_QUOTA） */
  quota?: Quota
}

const json = (status: number, body: unknown, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin')
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!origin || !allowed.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

async function handleApi(request: Request, env: Env, url: URL, deps: Deps): Promise<Response> {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json(200, { ok: true })
  }

  const isPull = url.pathname === '/api/sync/pull'
  const isPush = url.pathname === '/api/sync/push'
  if (!isPull && !isPush) return json(404, { error: 'not_found' })
  if ((isPull && request.method !== 'GET') || (isPush && request.method !== 'POST')) {
    return json(405, { error: 'method_not_allowed' }, { Allow: isPull ? 'GET' : 'POST' })
  }

  const policy = parseAllowedUsers(env.SYNC_ALLOWED_USER_IDS)
  let authConfig = deps.authConfig
  if (!authConfig && env.NEON_AUTH_BASE_URL) authConfig = authConfigFromBaseUrl(env.NEON_AUTH_BASE_URL)
  if (!authConfig || !policy) return json(503, { error: 'sync_not_configured' })

  const userId = await authenticate(request, authConfig)
  if (!isAllowed(policy, userId)) return json(403, { error: 'forbidden' })
  // ユーザーごとの上限。Run Mode 中の同期は 30 秒ごと（push・pull とも 120 回/時程度）
  await enforceRateLimit(env.DB, isPull ? 'sync_pull' : 'sync_push', userId, isPull ? 1200 : 600)

  if (isPull) {
    const since = parseSince(url.searchParams.get('since'))
    return json(200, await pull(env.DB, userId, since, PULL_PAGE_LIMIT))
  }
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    return json(415, { error: 'unsupported_media_type' })
  }
  const changes = parsePushBody(await readText(request, MAX_PUSH_BYTES))
  return json(200, await push(env.DB, userId, changes, deps.quota))
}

export async function handle(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : json(404, { error: 'not_found' })
  }

  if (url.pathname.startsWith('/api/auth/')) {
    try {
      return await proxyAuth(request, env, url.pathname.slice('/api/auth'.length), deps.fetch)
    } catch (e) {
      return errorResponse(e)
    }
  }

  if (url.pathname === '/api/webhooks/neon-auth') {
    // サーバー間の呼び出しなので CORS は付けない。認証は署名（Bearer ではない）
    let keys = deps.authConfig?.keys
    if (!keys && env.NEON_AUTH_BASE_URL) keys = authConfigFromBaseUrl(env.NEON_AUTH_BASE_URL).keys
    return handleAuthWebhook(request, env, keys, deps.fetch)
  }

  const cors = corsHeaders(request, env)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: Object.keys(cors).length > 0 ? 204 : 403, headers: cors })
  }

  let res: Response
  try {
    res = await handleApi(request, env, url, deps)
  } catch (e) {
    res = errorResponse(e)
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
  return res
}

function errorResponse(e: unknown): Response {
  if (e instanceof Unauthorized) {
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
  }
  if (e instanceof AuthUnavailable) {
    return json(503, { error: 'auth_unavailable' }, { 'Retry-After': '30' })
  }
  if (e instanceof RateLimited) {
    return json(429, { error: 'rate_limited' }, { 'Retry-After': String(e.retryAfterSec) })
  }
  if (e instanceof AuthProxyError) {
    const error = { 404: 'not_found', 405: 'method_not_allowed', 503: 'auth_not_configured' }
    return json(e.status, { error: error[e.status] })
  }
  if (e instanceof QuotaExceeded) {
    // 507 Insufficient Storage。使用量は本人のものだけなので返してよい
    return json(507, { error: 'quota_exceeded', usage: e.usage, limit: e.limit })
  }
  if (e instanceof BadRequest) {
    return json(e.status, { error: 'bad_request', message: e.message })
  }
  // 中継先（Neon）への通信失敗も含む。メッセージには URL が入りうるので種類だけを残す
  console.error('unhandled', e instanceof Error ? e.name : typeof e)
  return json(500, { error: 'internal' })
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
