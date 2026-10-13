/**
 * colloion Worker（Phase 3）。
 *
 * フロント（dist/）は同じ Worker の assets から配信し、API は /api/* に置く。
 * 同じオリジンになるので、本番では CORS も第三者 Cookie（Safari ITP）の問題も起きない。
 * ALLOWED_ORIGINS は vite の開発サーバー（別ポート）から叩くとき用。
 *
 *   GET  /api/health
 *   GET  /api/sync/pull?since=<rev>
 *   POST /api/sync/push   { changes: PushChange[] }
 */

import { MAX_PUSH_BYTES, PULL_PAGE_LIMIT } from '../src/sync/protocol'
import {
  AuthUnavailable,
  authConfigFromBaseUrl,
  authenticate,
  Unauthorized,
  type AuthConfig,
} from './auth'
import type { D1Like } from './db'
import { pull, push } from './sync'
import { BadRequest, parsePushBody, parseSince } from './validate'

export interface Env {
  DB: D1Like
  /** Neon Managed Better Auth の URL（公開情報）。未設定なら同期 API は 503 */
  NEON_AUTH_BASE_URL?: string
  /** CORS を許すオリジン（カンマ区切り）。本番は同一オリジンなので空 */
  ALLOWED_ORIGINS?: string
  ASSETS?: { fetch(request: Request): Promise<Response> }
}

/** テストで認証設定を差し替えるための口（本番は NEON_AUTH_BASE_URL から作る） */
export interface Deps {
  authConfig?: AuthConfig
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

/** 本文を上限付きで読む（Content-Length が無い・偽っている場合も上限で打ち切る） */
async function readText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > maxBytes) throw new BadRequest('リクエストが大きすぎます', 413)
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new BadRequest('リクエストが大きすぎます', 413)
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(buf)
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

  let authConfig = deps.authConfig
  if (!authConfig) {
    if (!env.NEON_AUTH_BASE_URL) return json(503, { error: 'sync_not_configured' })
    authConfig = authConfigFromBaseUrl(env.NEON_AUTH_BASE_URL)
  }
  const userId = await authenticate(request, authConfig)

  if (isPull) {
    const since = parseSince(url.searchParams.get('since'))
    return json(200, await pull(env.DB, userId, since, PULL_PAGE_LIMIT))
  }
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    return json(415, { error: 'unsupported_media_type' })
  }
  const changes = parsePushBody(await readText(request, MAX_PUSH_BYTES))
  return json(200, await push(env.DB, userId, changes))
}

export async function handle(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : json(404, { error: 'not_found' })
  }

  const cors = corsHeaders(request, env)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: Object.keys(cors).length > 0 ? 204 : 403, headers: cors })
  }

  let res: Response
  try {
    res = await handleApi(request, env, url, deps)
  } catch (e) {
    if (e instanceof Unauthorized) {
      res = json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    } else if (e instanceof AuthUnavailable) {
      res = json(503, { error: 'auth_unavailable' }, { 'Retry-After': '30' })
    } else if (e instanceof BadRequest) {
      res = json(e.status, { error: 'bad_request', message: e.message })
    } else {
      console.error('unhandled', e instanceof Error ? e.message : e)
      res = json(500, { error: 'internal' })
    }
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
  return res
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
}
