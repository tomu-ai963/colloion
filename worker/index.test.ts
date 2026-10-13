// @vitest-environment node
import { errors } from 'jose'
import { beforeEach, describe, expect, it } from 'vitest'
import { handle, type Env } from './index'
import { createTestAuth, type TestAuth } from './testing/auth'
import { SqliteD1 } from './testing/sqliteD1'

const ORIGIN = 'https://colloion.tomu-ai.dev'

let auth: TestAuth
let db: SqliteD1
let env: Env

const call = (path: string, init: RequestInit = {}, deps = { authConfig: auth.config }) =>
  handle(new Request(`${ORIGIN}${path}`, init), env, deps)

const authed = async (sub = 'user-a', init: RequestInit = {}): Promise<RequestInit> => ({
  ...init,
  headers: { ...init.headers, Authorization: `Bearer ${await auth.token(sub)}` },
})

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'x',
  formula: 'NaCl',
  mw: 58.44,
  purityPct: 100,
  role: '電解質',
  updatedAt: 1,
  ...extra,
})

const pushBody = (changes: unknown[]) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ changes }),
})

beforeEach(async () => {
  auth = await createTestAuth()
  db = new SqliteD1()
  env = { DB: db, ALLOWED_ORIGINS: 'http://localhost:5173', SYNC_ALLOWED_USER_IDS: 'user-a, user-b' }
})

describe('Worker: ルーティング', () => {
  it('health は認証なしで 200', async () => {
    const res = await call('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('/api 以外は assets に渡す', async () => {
    env.ASSETS = { fetch: async () => new Response('<html>app</html>') }
    expect(await (await call('/')).text()).toBe('<html>app</html>')
  })

  it('知らないパスは 404・メソッド違いは 405', async () => {
    expect((await call('/api/nope')).status).toBe(404)
    const res = await call('/api/sync/push', await authed())
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })

  it('API の応答はキャッシュさせない', async () => {
    const res = await call('/api/sync/pull', await authed())
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })
})

describe('Worker: 認証', () => {
  it('トークンが無ければ 401', async () => {
    const res = await call('/api/sync/pull')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('署名が違う・期限切れ・発行元違い・宛先違い・利用停止は 401', async () => {
    const bad = [
      await auth.forgedToken('user-a'),
      await auth.token('user-a', { expiresIn: '-1m' }),
      await auth.token('user-a', { issuer: 'https://evil.example' }),
      await auth.token('user-a', { audience: 'https://evil.example' }),
      await auth.token('user-a', { banned: true }),
      'not-a-jwt',
    ]
    for (const t of bad) {
      const res = await call('/api/sync/pull', { headers: { Authorization: `Bearer ${t}` } })
      expect(res.status, t).toBe(401)
    }
  })

  it('認証基盤（JWKS）に届かないときは 503（クライアントは再試行する）', async () => {
    const token = await auth.token('user-a')
    for (const failure of [new errors.JWKSTimeout(), new TypeError('fetch failed')]) {
      const res = await handle(
        new Request(`${ORIGIN}/api/sync/pull`, { headers: { Authorization: `Bearer ${token}` } }),
        env,
        { authConfig: { ...auth.config, keys: async () => Promise.reject(failure) } },
      )
      expect(res.status).toBe(503)
    }
  })

  it('NEON_AUTH_BASE_URL が無ければ同期 API は 503（認証なしでは動かない）', async () => {
    const res = await handle(new Request(`${ORIGIN}/api/sync/pull`), env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'sync_not_configured' })
  })
})

describe('Worker: 同期を使えるユーザー（許可リスト）', () => {
  it('許可リストが未設定・空なら、認証できても同期 API は 503（全開放に倒れない）', async () => {
    for (const v of [undefined, '', ' , ']) {
      env.SYNC_ALLOWED_USER_IDS = v
      const res = await call('/api/sync/pull', await authed('user-a'))
      expect(res.status, String(v)).toBe(503)
      expect(await res.json()).toEqual({ error: 'sync_not_configured' })
    }
  })

  it('リストに無いユーザーは 403（理由は forbidden）で、何も書かれない', async () => {
    const res = await call(
      '/api/sync/push',
      await authed('stranger', pushBody([{ kind: 'reagent', id: 'a', baseRev: null, record: record('a') }])),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
  })

  it('リストにあるユーザーは通り、`*` なら誰でも通る', async () => {
    expect((await call('/api/sync/pull', await authed('user-b'))).status).toBe(200)
    env.SYNC_ALLOWED_USER_IDS = '*'
    expect((await call('/api/sync/pull', await authed('anyone'))).status).toBe(200)
  })

  it('認証より前に許可リストを見ない（未認証は 401 のまま。リストの有無を漏らさない）', async () => {
    expect((await call('/api/sync/pull')).status).toBe(401)
  })
})

describe('Worker: ユーザーごとのレート制限', () => {
  it('push は 1 時間に 600 回まで。別のユーザーには影響しない', async () => {
    const init = async (sub: string) => authed(sub, pushBody([]))
    const a = await init('user-a')
    for (let i = 0; i < 600; i++) {
      const res = await call('/api/sync/push', a)
      expect(res.status).toBe(200)
    }
    const over = await call('/api/sync/push', a)
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ error: 'rate_limited' })
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await call('/api/sync/push', await init('user-b'))).status).toBe(200)
    // pull は別の枠
    expect((await call('/api/sync/pull', await authed('user-a'))).status).toBe(200)
  })

  it('最大件数・全件競合の push でも、1 リクエストの D1 クエリ数は Free の上限 50 に収まる', async () => {
    const changes = Array.from({ length: 40 }, (_, i) => ({
      kind: 'reagent',
      id: `r${i}`,
      baseRev: null,
      record: record(`r${i}`),
    }))
    expect((await call('/api/sync/push', await authed('user-a', pushBody(changes)))).status).toBe(200)
    db.queries = 0
    const res = await call('/api/sync/push', await authed('user-a', pushBody(changes)))
    const body = (await res.json()) as { results: { status: string }[] }
    expect(body.results.every((r) => r.status === 'conflict')).toBe(true)
    expect(db.queries).toBeLessThanOrEqual(50)
  })
})

describe('Worker: 入力の検査', () => {
  it('Content-Type が JSON でなければ 415', async () => {
    const res = await call('/api/sync/push', await authed('user-a', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(415)
  })

  it('不正な push は 400 で、何も書かれない', async () => {
    const cases = [
      'not json',
      JSON.stringify({}),
      JSON.stringify({ changes: [{ kind: 'user', id: 'a', baseRev: null, record: record('a') }] }),
      JSON.stringify({ changes: [{ kind: 'reagent', id: 'a/../b', baseRev: null, record: record('a/../b') }] }),
      JSON.stringify({ changes: [{ kind: 'reagent', id: 'a', baseRev: -1, record: record('a') }] }),
      JSON.stringify({ changes: [{ kind: 'reagent', id: 'a', baseRev: null, record: record('b') }] }),
      JSON.stringify({ changes: [{ kind: 'reagent', id: 'a', baseRev: null, record: record('a', { updatedAt: 'x' }) }] }),
      JSON.stringify({
        changes: [
          { kind: 'reagent', id: 'a', baseRev: null, record: record('a') },
          { kind: 'reagent', id: 'a', baseRev: null, record: record('a') },
        ],
      }),
      JSON.stringify({
        changes: Array.from({ length: 41 }, (_, i) => ({
          kind: 'reagent',
          id: `r${i}`,
          baseRev: null,
          record: record(`r${i}`),
        })),
      }),
    ]
    for (const body of cases) {
      const res = await call(
        '/api/sync/push',
        await authed('user-a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
      )
      expect(res.status, body.slice(0, 80)).toBe(400)
    }
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })
  })

  it('大きすぎるレコード・本文は 413', async () => {
    const big = record('a', { note: 'x'.repeat(300 * 1024) })
    const res = await call(
      '/api/sync/push',
      await authed('user-a', pushBody([{ kind: 'reagent', id: 'a', baseRev: null, record: big }])),
    )
    expect(res.status).toBe(413)

    const huge = await call(
      '/api/sync/push',
      await authed('user-a', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(5 * 1024 * 1024),
      }),
    )
    expect(huge.status).toBe(413)
  })

  it('since は 0 以上の整数のみ', async () => {
    for (const q of ['-1', '1.5', 'abc', '1e3']) {
      expect((await call(`/api/sync/pull?since=${q}`, await authed())).status, q).toBe(400)
    }
  })
})

describe('Worker: CORS（開発サーバー用）', () => {
  it('許可したオリジンにだけ CORS ヘッダーを返す', async () => {
    const ok = await call('/api/health', { headers: { Origin: 'http://localhost:5173' } })
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(ok.headers.get('Vary')).toBe('Origin')

    const ng = await call('/api/health', { headers: { Origin: 'https://evil.example' } })
    expect(ng.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('プリフライトは許可オリジンなら 204、それ以外は 403', async () => {
    const pre = (origin: string) =>
      call('/api/sync/push', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      })
    const ok = await pre('http://localhost:5173')
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect((await pre('https://evil.example')).status).toBe(403)
  })

  it('401 の応答にも CORS ヘッダーが付く（ブラウザがエラー内容を読めるように）', async () => {
    const res = await call('/api/sync/pull', { headers: { Origin: 'http://localhost:5173' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })
})
