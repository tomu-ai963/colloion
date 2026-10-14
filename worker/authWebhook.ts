/**
 * POST /api/webhooks/neon-auth — Neon Managed Better Auth の webhook の受け口。
 *
 * 目的はログインコード（send.otp）のメールを日本語にすること。send.otp を購読すると
 * Neon は自分のメール（英語の既定テンプレート）を送らなくなるので、ここで Resend から送る。
 * **購読中にここが失敗し続けるとログインできなくなる**（Neon は 3 回試して諦め、既定の送信には戻らない）。
 * 止めるときは Neon 側の webhook を無効にする（README「ログインコードのメール」）。
 *
 * 署名は detached JWS（Ed25519）で、鍵は JWT と同じ JWKS（worker/auth.ts の authConfig.keys）。
 *   X-Neon-Signature     : "<protectedHeaderB64>..<signatureB64>"（中央は空）
 *   X-Neon-Timestamp     : unix ミリ秒
 *   署名対象 = protectedHeaderB64 + "." + base64url(timestamp + "." + base64url(生ボディ))
 * 出典は https://neon.com/docs/auth/guides/webhooks 。bitane（src/lib/neon-auth-webhook.ts）で実機確認済み。
 *
 * payload の形（イベント固有の値は `event_data`、宛先は `user.email`）も同じ出典で確定している。
 * 形が合わなければ 400 で大きく失敗させ、別のキーを推測で拾わない（bitane で一度踏んだ）。
 */

import { flattenedVerify } from 'jose'
import { isJwksFetchFailure, type AuthConfig } from './auth'

/** タイムスタンプの許容窓（前後とも）。Neon のガイドは「5 分より古いものは拒否」を推奨 */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60_000
/**
 * Resend への 1 回の送信の打ち切り。Neon は 1 回の試行を timeout_seconds（5 秒で設定する）で切り、
 * 3 回・合計 15 秒まで試す。その内側で返して、Neon の再試行に回せるようにする
 */
const SEND_TIMEOUT_MS = 4_000
const RESEND_ENDPOINT = 'https://api.resend.com/emails'
/** 生ボディの上限。payload は 1 KB 程度 */
const MAX_BODY_BYTES = 64 * 1024

export interface WebhookEnv {
  /** Resend の API キー（送信のみ）。本番は `wrangler secret put`、ローカルは .dev.vars */
  RESEND_API_KEY?: string
  /** 差出人（例 `colloion <no-reply@tomu-ai.dev>`）。秘密ではないので wrangler.jsonc の vars */
  MAIL_FROM?: string
}

type Reject = 'missing_headers' | 'malformed_signature' | 'timestamp_out_of_window' | 'invalid_signature'

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null

const b64url = (s: string): string => {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

/**
 * 署名とタイムスタンプを検証して payload を返す。
 * 失敗理由はログ用。**応答には出さない**
 */
export async function verifyWebhook(
  rawBody: string,
  headers: Headers,
  keys: AuthConfig['keys'],
  nowMs = Date.now(),
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: Reject }> {
  const signature = headers.get('x-neon-signature')
  const timestamp = headers.get('x-neon-timestamp')
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' }

  const parts = signature.split('.')
  if (parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]) {
    return { ok: false, reason: 'malformed_signature' }
  }
  // 窓の判定は鍵を取りに行く前に行う（古いリクエストで JWKS を叩かせない）
  const ts = Number(timestamp)
  if (!/^\d{1,16}$/.test(timestamp) || Math.abs(nowMs - ts) > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp_out_of_window' }
  }

  try {
    // 鍵は protected header の kid で JWKS から選ばれる（X-Neon-Signature-Kid は署名対象外なので使わない）
    await flattenedVerify(
      { protected: parts[0], payload: b64url(`${timestamp}.${b64url(rawBody)}`), signature: parts[2] },
      // JWKS の鍵選び（createRemoteJWKSet）は JWT 用の型だが、見るのは alg と kid だけなので同じものが使える。
      // alg は algorithms で EdDSA に限っているので、ここに来る時点で必ずある
      (header, token) => keys({ ...header, alg: header.alg! }, token),
      { algorithms: ['EdDSA'] },
    )
  } catch (e) {
    if (isJwksFetchFailure(e)) throw e // Neon 側の一時的な不調。再試行で回復しうる
    return { ok: false, reason: 'invalid_signature' }
  }
  try {
    return { ok: true, payload: JSON.parse(rawBody) }
  } catch {
    return { ok: false, reason: 'malformed_signature' }
  }
}

export interface OtpEvent {
  eventId: string
  to: string
  code: string
  type: string
  /** 有効期限までの分数。読めなければ null（文言から省く） */
  minutes: number | null
}

/** send.otp の payload から必要な値を取り出す。形が違えば null */
export function readOtpEvent(payload: Json, nowMs = Date.now()): OtpEvent | null {
  const user = asObject(payload.user)
  const data = asObject(payload.event_data)
  const eventId = payload.event_id
  const to = user?.email
  const code = data?.otp_code
  const type = data?.otp_type
  if (typeof eventId !== 'string' || eventId === '') return null
  if (typeof to !== 'string' || !to.includes('@')) return null
  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code)) return null
  if (typeof type !== 'string') return null
  const expires = typeof data?.expires_at === 'string' ? Date.parse(data.expires_at) : NaN
  const minutes = Number.isFinite(expires) ? Math.round((expires - nowMs) / 60_000) : NaN
  return { eventId, to, code, type, minutes: minutes > 0 ? minutes : null }
}

const PURPOSE: Record<string, string> = {
  'sign-in': 'ログイン',
  'email-verification': 'メールアドレスの確認',
  'forget-password': 'パスワードの再設定',
}

/** 日本語のメール。コードは件名に入れない（ロック画面の通知に出るため） */
export function otpMail(e: Pick<OtpEvent, 'code' | 'type' | 'minutes'>): { subject: string; text: string } {
  const purpose = PURPOSE[e.type] ?? '確認'
  const limit = e.minutes === null ? '' : `このコードは約${e.minutes}分で使えなくなります。\n`
  return {
    subject: `colloion の${purpose}用コード`,
    text:
      `colloion の${purpose}用のコードをお送りします。\n\n` +
      `    ${e.code}\n\n` +
      `画面に表示されている入力欄に、この6桁の数字を入れてください。\n` +
      limit +
      `\n心当たりがない場合は、このメールを破棄してください。` +
      `コードを知られない限り、アカウントには入れません。\n\n` +
      `colloion\nhttps://colloion.tomu-ai.dev\n`,
  }
}

export async function handleAuthWebhook(
  request: Request,
  env: WebhookEnv,
  keys: AuthConfig['keys'] | undefined,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!keys || !env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.error('neon-auth webhook: not configured')
    return json(503, { error: 'not_configured' })
  }
  if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY_BYTES) {
    return json(413, { error: 'too_large' })
  }
  // 署名は生ボディに対して検証する（パースしてから戻すと整形差で壊れる）
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' })

  let verified: Awaited<ReturnType<typeof verifyWebhook>>
  try {
    verified = await verifyWebhook(rawBody, request.headers, keys)
  } catch {
    console.error('neon-auth webhook: jwks unavailable')
    return json(503, { error: 'jwks_unavailable' }) // 5xx は Neon が再試行する
  }
  if (!verified.ok) {
    // 4xx は再試行されない。署名が合わないものは何度来ても合わない。
    // invalid_signature は鍵の入れ替えや NEON_AUTH_BASE_URL の誤りでも起き、そのときはメールが届かなくなる
    console[verified.reason === 'invalid_signature' ? 'error' : 'warn']('neon-auth webhook rejected', verified.reason)
    return json(400, { error: 'invalid_signature' })
  }

  const payload = asObject(verified.payload)
  // 分岐は署名対象の本文から取る（X-Neon-Event-Type ヘッダは署名に含まれない）
  const eventType = payload?.event_type
  if (eventType !== 'send.otp') {
    // 購読していないイベントは成功扱いで捨てる（再試行させない）
    return json(200, { received: true, ignored: typeof eventType === 'string' ? eventType : 'unknown' })
  }
  const event = readOtpEvent(payload!)
  if (!event) {
    // 値には宛先やコードが入るのでキー名だけを残す
    console.error('neon-auth webhook: unsupported payload', Object.keys(payload!).join(','))
    return json(400, { error: 'unsupported_payload' })
  }

  const mail = otpMail(event)
  let res: Response
  try {
    res = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        // Neon は失敗時に同じ event_id で再送する。Resend 側で 24 時間は同じ送信として扱われ、2 通届かない
        'Idempotency-Key': `neon-otp-${event.eventId}`,
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [event.to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (e) {
    console.error('neon-auth webhook: resend unreachable', e instanceof Error ? e.name : typeof e)
    return json(502, { error: 'mail_failed' })
  }
  if (!res.ok) {
    // Resend の本文には宛先が入りうるので状態コードだけを残す
    console.error('neon-auth webhook: resend rejected', res.status)
    return json(502, { error: 'mail_failed' })
  }
  return json(200, { received: true })
}
