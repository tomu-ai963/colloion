// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rewriteLocation, rewriteSetCookie } from './authProxy'
import { handle, type Env } from './index'
import { SqliteD1 } from './testing/sqliteD1'

const APP = 'https://colloion.tomu-ai.dev'
const NEON = 'https://ep-test.aws.neon.tech'
const NEON_AUTH = `${NEON}/neondb/auth`

let env: Env
let upstream: ReturnType<typeof vi.fn<typeof fetch>>

const call = (path: string, init: RequestInit = {}) =>
  handle(new Request(`${APP}${path}`, init), env, { fetch: upstream })

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: APP, ...headers },
  body: JSON.stringify(body),
})

beforeEach(() => {
  env = { DB: new SqliteD1(), NEON_AUTH_BASE_URL: NEON_AUTH }
  upstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
})

describe('認証の中継: 転送先と許可リスト', () => {
  it('使うエンドポイントだけを Neon の auth URL 配下へ転送する', async () => {
    const ok = [
      ['/api/auth/get-session', { method: 'GET' }],
      ['/api/auth/token', { method: 'GET' }],
      ['/api/auth/email-otp/send-verification-otp', post({ email: 'a@example.com', type: 'sign-in' })],
      ['/api/auth/sign-in/email-otp', post({ email: 'a@example.com', otp: '123456' })],
      ['/api/auth/sign-out', post({})],
    ] as const
    for (const [path, init] of ok) {
      expect((await call(path, init)).status, path).toBe(200)
    }
    expect(upstream.mock.calls.map((c) => c[0])).toEqual([
      `${NEON_AUTH}/get-session`,
      `${NEON_AUTH}/token`,
      `${NEON_AUTH}/email-otp/send-verification-otp`,
      `${NEON_AUTH}/sign-in/email-otp`,
      `${NEON_AUTH}/sign-out`,
    ])
  })

  it('使っていない経路（パスワードでのサインアップ等）は上流に流さず 404', async () => {
    for (const path of [
      '/api/auth/sign-up/email',
      '/api/auth/sign-in/email',
      '/api/auth/admin/list-users',
      '/api/auth/get-session/../admin',
      '/api/auth/',
    ]) {
      expect((await call(path, post({}))).status, path).toBe(404)
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('メソッド違いは 405', async () => {
    expect((await call('/api/auth/sign-out', { method: 'GET' })).status).toBe(405)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('NEON_AUTH_BASE_URL が無ければ 503', async () => {
    env.NEON_AUTH_BASE_URL = undefined
    expect((await call('/api/auth/get-session')).status).toBe(503)
  })

  it('本文が大きすぎれば 413（Content-Length を偽っても読みながら打ち切る）', async () => {
    const res = await call('/api/auth/sign-in/email-otp', post({ email: 'x'.repeat(20_000) }))
    expect(res.status).toBe(413)

    // Content-Length を付けない（chunked）本文でも上限で止まる
    const chunk = new TextEncoder().encode('x'.repeat(8 * 1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 1024) return controller.close() // 8 MB まで出せるが、途中で読み捨てられるはず
        sent++
        controller.enqueue(chunk)
      },
    })
    const res2 = await handle(
      new Request(`${APP}/api/auth/sign-in/email-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      env,
      { fetch: upstream },
    )
    expect(res2.status).toBe(413)
    expect(sent).toBeLessThan(10) // 16 KB を超えた時点で読むのをやめている
    expect(upstream).not.toHaveBeenCalled()
  })

  it('上流に届かなければ 500（理由は返さない）', async () => {
    upstream.mockRejectedValueOnce(new TypeError(`fetch failed: ${NEON}`))
    const res = await call('/api/auth/get-session')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('neon.tech')
  })
})

describe('認証の中継: ヘッダー', () => {
  it('CSRF 防御に要るヘッダー（Origin・Cookie・Sec-Fetch-*）を素通しし、それ以外は渡さない', async () => {
    await call('/api/auth/sign-out', {
      ...post({}),
      headers: {
        'Content-Type': 'application/json',
        Origin: APP,
        Referer: `${APP}/`,
        Cookie: '__Secure-neon-auth.session_token=abc',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'CF-Connecting-IP': '203.0.113.1',
        Authorization: 'Bearer should-not-forward',
      },
    })
    const init = upstream.mock.calls[0]![1]!
    const h = new Headers(init.headers)
    expect(h.get('origin')).toBe(APP)
    expect(h.get('referer')).toBe(`${APP}/`)
    expect(h.get('cookie')).toBe('__Secure-neon-auth.session_token=abc')
    expect(h.get('sec-fetch-site')).toBe('same-origin')
    expect(h.get('cf-connecting-ip')).toBeNull()
    expect(h.get('authorization')).toBeNull()
    expect(init.redirect).toBe('manual')
  })

  it('Set-Cookie を同一サイト向けに書き換え、CORS 許可と上流のキャッシュ指示は落とす', async () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://evil.example',
      'Access-Control-Allow-Credentials': 'true',
      'Cache-Control': 'public, max-age=3600',
      Location: `${NEON}/neondb/auth/callback?x=1`,
    })
    headers.append(
      'Set-Cookie',
      '__Secure-neon-auth.session_token=abc; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
    )
    headers.append('Set-Cookie', '__Secure-neon-auth.session_data=def; Path=/; Secure; HttpOnly')
    upstream.mockResolvedValueOnce(new Response('{}', { status: 302, headers }))

    const res = await call('/api/auth/sign-in/email-otp', post({ email: 'a@example.com', otp: '1' }))
    expect(res.headers.getSetCookie()).toEqual([
      '__Secure-neon-auth.session_token=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Secure-neon-auth.session_data=def; Path=/; Secure; HttpOnly; SameSite=Lax',
    ])
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Location')).toBe('/neondb/auth/callback?x=1')
  })

  it('認証の経路には開発用の CORS 許可も付けない（Cookie を扱うため同一オリジン専用）', async () => {
    env.ALLOWED_ORIGINS = 'http://localhost:5173'
    const res = await call('/api/auth/get-session', { headers: { Origin: 'http://localhost:5173' } })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('認証の中継: レート制限', () => {
  it('同じメール宛ての OTP 送信は 1 時間に 5 回まで（大文字小文字・前後空白は同一視）', async () => {
    const send = (email: string) =>
      call('/api/auth/email-otp/send-verification-otp', post({ email, type: 'sign-in' }))
    for (let i = 0; i < 5; i++) expect((await send(i % 2 ? 'A@Example.com ' : 'a@example.com')).status).toBe(200)
    const res = await send('a@example.com')
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(upstream).toHaveBeenCalledTimes(5)
    // 別のアドレスは影響を受けない
    expect((await send('b@example.com')).status).toBe(200)
  })

  it('同じ IP からの OTP 送信は 1 時間に 20 回まで', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await call(
        '/api/auth/email-otp/send-verification-otp',
        post({ email: `u${i}@example.com` }, { 'CF-Connecting-IP': '203.0.113.9' }),
      )
      expect(res.status).toBe(200)
    }
    const res = await call(
      '/api/auth/email-otp/send-verification-otp',
      post({ email: 'u99@example.com' }, { 'CF-Connecting-IP': '203.0.113.9' }),
    )
    expect(res.status).toBe(429)
  })

  it('同じ IP からのコード検証は 1 時間に 30 回まで', async () => {
    const verify = () =>
      call('/api/auth/sign-in/email-otp', post({ email: 'a@example.com', otp: '000000' }, { 'CF-Connecting-IP': '198.51.100.7' }))
    for (let i = 0; i < 30; i++) expect((await verify()).status).toBe(200)
    expect((await verify()).status).toBe(429)
  })
})

describe('書き換え関数', () => {
  it('SameSite が無い Cookie には Lax を足す', () => {
    expect(rewriteSetCookie('a=b; Path=/')).toBe('a=b; Path=/; SameSite=Lax')
  })
  it('上流以外を指す Location はそのまま', () => {
    expect(rewriteLocation('https://other.example/x', NEON)).toBe('https://other.example/x')
    expect(rewriteLocation(NEON, NEON)).toBe('/')
  })
})
