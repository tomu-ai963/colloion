// @vitest-environment node
/**
 * webhook の署名は、検証側（jose）とは独立に Neon のドキュメントの手順どおり node:crypto で作る。
 * 同じライブラリで作ると、両方が同じ誤りを持ったまま通ってしまうため（bitane で payload の形を
 * 推測で書き、実装とテストが揃って間違えていた）。
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthConfig } from './auth'
import { otpMail, readOtpEvent, TIMESTAMP_TOLERANCE_MS } from './authWebhook'
import { handle, type Env } from './index'
import { SqliteD1 } from './testing/sqliteD1'

const APP = 'https://colloion.tomu-ai.dev'
const KID = 'neon-key-1'
const NOW = Date.parse('2026-10-14T05:00:00.000Z')

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

const neonKey = generateKeyPairSync('ed25519')
const otherKey = generateKeyPairSync('ed25519')

/** Neon の手順: signingInput = header + "." + b64url(timestamp + "." + b64url(rawBody)) */
function neonSignature(rawBody: string, timestamp: string, privateKey: KeyObject = neonKey.privateKey) {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWS', kid: KID }))
  const signingInput = `${header}.${b64url(`${timestamp}.${b64url(rawBody)}`)}`
  return `${header}..${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`
}

const otpPayload = (patch: Record<string, unknown> = {}) => ({
  event_id: 'evt-1',
  event_type: 'send.otp',
  timestamp: '2026-10-14T05:00:00.000Z',
  context: { endpoint_id: 'ep-test', project_name: 'colloion' },
  user: { id: 'user-1', email: 'tomu@example.com', email_verified: true },
  event_data: {
    otp_code: '482913',
    otp_type: 'sign-in',
    expires_at: '2026-10-14T05:05:00.000Z',
    ip_address: '192.0.2.1',
    user_agent: 'Mozilla/5.0',
  },
  ...patch,
})

let env: Env
let resend: ReturnType<typeof vi.fn<typeof fetch>>
let keys: AuthConfig['keys']

function webhook(
  body: unknown,
  opts: { timestamp?: number; privateKey?: KeyObject; headers?: Record<string, string>; tamper?: (raw: string) => string } = {},
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const ts = String(opts.timestamp ?? Date.now())
  const headers = {
    'Content-Type': 'application/json',
    'X-Neon-Signature': neonSignature(raw, ts, opts.privateKey),
    'X-Neon-Signature-Kid': KID,
    'X-Neon-Timestamp': ts,
    'X-Neon-Event-Type': 'send.otp',
    'X-Neon-Event-Id': 'evt-1',
    'X-Neon-Delivery-Attempt': '1',
    ...opts.headers,
  }
  const sent = opts.tamper ? opts.tamper(raw) : raw
  return handle(new Request(`${APP}/api/webhooks/neon-auth`, { method: 'POST', headers, body: sent }), env, {
    authConfig: { issuer: 'x', audience: 'x', keys },
    fetch: resend,
  })
}

beforeEach(() => {
  env = { DB: new SqliteD1(), RESEND_API_KEY: 'test-resend-key', MAIL_FROM: 'colloion <no-reply@tomu-ai.dev>' }
  resend = vi.fn<typeof fetch>(async () => Response.json({ id: 'email-1' }))
  // createRemoteJWKSet と同じく、kid で鍵を選び、無ければ投げる
  keys = async (header) => {
    if (header.kid !== KID) throw new Error('no matching key')
    return neonKey.publicKey
  }
})

describe('webhook: send.otp を日本語のメールで送る', () => {
  it('正しい署名の send.otp は Resend に 1 通送り、200', async () => {
    const res = await webhook(otpPayload())
    expect(res.status).toBe(200)
    expect(resend).toHaveBeenCalledTimes(1)
    const [url, init] = resend.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    const headers = new Headers(init!.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-resend-key')
    // Neon の再送（同じ event_id）で 2 通届かないように
    expect(headers.get('Idempotency-Key')).toBe('neon-otp-evt-1')
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({
      from: 'colloion <no-reply@tomu-ai.dev>',
      to: ['tomu@example.com'],
      subject: 'colloion のログイン用コード',
    })
    expect(body.text).toContain('482913')
    expect(body.subject).not.toContain('482913')
  })

  it('本文を 1 文字でも変えると 400 で、送らない（4xx は Neon が再試行しない）', async () => {
    const res = await webhook(otpPayload(), { tamper: (raw) => raw.replace('482913', '000000') })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_signature' })
    expect(resend).not.toHaveBeenCalled()
  })

  it('別の鍵の署名・知らない kid・ヘッダ欠け・形の崩れた署名は 400', async () => {
    expect((await webhook(otpPayload(), { privateKey: otherKey.privateKey })).status).toBe(400)
    const raw = JSON.stringify(otpPayload())
    const ts = String(Date.now())
    const unknownKid = neonSignature(raw, ts).replace(
      /^[^.]+/,
      b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWS', kid: 'other' })),
    )
    expect((await webhook(raw, { timestamp: Number(ts), headers: { 'X-Neon-Signature': unknownKid } })).status).toBe(400)
    expect((await webhook(otpPayload(), { headers: { 'X-Neon-Signature': '' } })).status).toBe(400)
    expect((await webhook(otpPayload(), { headers: { 'X-Neon-Signature': 'a.b.c' } })).status).toBe(400)
    expect((await webhook(otpPayload(), { headers: { 'X-Neon-Timestamp': 'abc' } })).status).toBe(400)
    expect(resend).not.toHaveBeenCalled()
  })

  it('タイムスタンプが前後 5 分を超えたものは 400（署名は正しくても再生攻撃として拒否）', async () => {
    const old = Date.now() - TIMESTAMP_TOLERANCE_MS - 1000
    const future = Date.now() + TIMESTAMP_TOLERANCE_MS + 1000
    expect((await webhook(otpPayload(), { timestamp: old })).status).toBe(400)
    expect((await webhook(otpPayload(), { timestamp: future })).status).toBe(400)
    expect((await webhook(otpPayload(), { timestamp: Date.now() - 60_000 })).status).toBe(200)
  })

  it('send.otp 以外のイベントは送らずに 200（分岐は署名された本文で決め、ヘッダは見ない）', async () => {
    const res = await webhook(otpPayload({ event_type: 'user.created' }), { headers: { 'X-Neon-Event-Type': 'send.otp' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, ignored: 'user.created' })
    expect(resend).not.toHaveBeenCalled()
  })

  it('send.otp なのに宛先やコードが取れない形は 400（推測で別のキーを拾わない）', async () => {
    const noCode = otpPayload({ event_data: { otp_type: 'sign-in' } })
    const dataKey = { ...otpPayload(), event_data: undefined, data: otpPayload().event_data }
    const noEmail = otpPayload({ user: { id: 'user-1' } })
    for (const p of [noCode, dataKey, noEmail]) {
      expect((await webhook(p)).status).toBe(400)
    }
    expect(resend).not.toHaveBeenCalled()
  })

  it('Resend が失敗・応答しないときは 502（5xx なので Neon が再試行する）', async () => {
    resend.mockResolvedValueOnce(new Response('{"message":"rate limited"}', { status: 429 }))
    expect((await webhook(otpPayload())).status).toBe(502)
    resend.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect((await webhook(otpPayload())).status).toBe(502)
  })

  it('JWKS に届かないときは 503（Neon が再試行する）', async () => {
    keys = async () => {
      throw new TypeError('fetch failed')
    }
    expect((await webhook(otpPayload())).status).toBe(503)
    expect(resend).not.toHaveBeenCalled()
  })

  it('RESEND_API_KEY・MAIL_FROM・NEON_AUTH_BASE_URL のどれかが無ければ 503', async () => {
    env.RESEND_API_KEY = undefined
    expect((await webhook(otpPayload())).status).toBe(503)
    env.RESEND_API_KEY = 'k'
    env.MAIL_FROM = undefined
    expect((await webhook(otpPayload())).status).toBe(503)
    env.MAIL_FROM = 'colloion <no-reply@tomu-ai.dev>'
    const noAuth = await handle(new Request(`${APP}/api/webhooks/neon-auth`, { method: 'POST', body: '{}' }), env, {
      fetch: resend,
    })
    expect(noAuth.status).toBe(503)
  })

  it('POST 以外は 405、大きすぎる本文は 413', async () => {
    const get = await handle(new Request(`${APP}/api/webhooks/neon-auth`), env, {
      authConfig: { issuer: 'x', audience: 'x', keys },
    })
    expect(get.status).toBe(405)
    expect((await webhook('x'.repeat(70 * 1024))).status).toBe(413)
  })
})

describe('メールの文面', () => {
  it('用途ごとの件名と、有効期限の分数', () => {
    expect(otpMail({ code: '123456', type: 'sign-in', minutes: 5 })).toMatchObject({
      subject: 'colloion のログイン用コード',
    })
    expect(otpMail({ code: '123456', type: 'sign-in', minutes: 5 }).text).toContain('約5分')
    expect(otpMail({ code: '123456', type: 'email-verification', minutes: null }).subject).toBe(
      'colloion のメールアドレスの確認用コード',
    )
    expect(otpMail({ code: '123456', type: 'unknown', minutes: null }).text).not.toContain('分で使えなく')
  })

  it('有効期限は expires_at から分に丸め、過ぎていれば出さない', () => {
    expect(readOtpEvent(otpPayload(), NOW)?.minutes).toBe(5)
    expect(readOtpEvent(otpPayload(), NOW + 10 * 60_000)?.minutes).toBeNull()
    expect(readOtpEvent(otpPayload({ event_data: { ...otpPayload().event_data, expires_at: 'x' } }), NOW)?.minutes).toBeNull()
  })
})
