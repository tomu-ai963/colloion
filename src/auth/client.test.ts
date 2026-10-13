import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthApiError,
  clearAccessToken,
  getAccessToken,
  getSession,
  jwtExpMs,
  sendSignInOtp,
  signInWithOtp,
} from './client'

const NOW = 1_760_000_000_000

/** exp だけ入った JWT（署名は検証しないので形だけ） */
const jwt = (expSec: number) =>
  `h.${btoa(JSON.stringify({ sub: 'u', exp: expSec })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  clearAccessToken()
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('アクセストークン', () => {
  it('取得したトークンを期限の 60 秒前まで使い回す', async () => {
    const token = jwt(NOW / 1000 + 900)
    fetchMock.mockImplementation(async () => Response.json({ token })) // Response は呼ぶたびに作る
    expect(await getAccessToken(NOW)).toBe(token)
    expect(await getAccessToken(NOW + 800_000)).toBe(token)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await getAccessToken(NOW + 850_000) // 残り 50 秒 → 取り直す
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/auth/token')
  })

  it('同時に呼ばれても /token は 1 回だけ', async () => {
    fetchMock.mockResolvedValue(Response.json({ token: jwt(NOW / 1000 + 900) }))
    await Promise.all([getAccessToken(NOW), getAccessToken(NOW), getAccessToken(NOW)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('セッション切れ（401）なら null。それ以外の失敗は投げる（同期エンジンが再試行する）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    expect(await getAccessToken(NOW)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(getAccessToken(NOW)).rejects.toBeInstanceOf(AuthApiError)
  })

  it('jwtExpMs は壊れたトークンなら 0', () => {
    expect(jwtExpMs(jwt(1234))).toBe(1_234_000)
    expect(jwtExpMs('broken')).toBe(0)
  })
})

describe('サインイン', () => {
  it('コードの送信は sign-in 種別で、Cookie を同一オリジンで送る', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }))
    await sendSignInOtp('  a@example.com ')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/auth/email-otp/send-verification-otp')
    expect(init!.credentials).toBe('same-origin')
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'a@example.com', type: 'sign-in' })
  })

  it('サインインに成功したらユーザーを返し、古いトークンを捨てる', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ token: jwt(NOW / 1000 + 900) }))
    await getAccessToken(NOW)
    fetchMock.mockResolvedValueOnce(Response.json({ user: { id: 'u1', email: 'a@example.com' } }))
    expect(await signInWithOtp('a@example.com', ' 123456 ')).toEqual({ id: 'u1', email: 'a@example.com' })
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      email: 'a@example.com',
      otp: '123456',
    })
    fetchMock.mockResolvedValueOnce(Response.json({ token: jwt(NOW / 1000 + 900) }))
    await getAccessToken(NOW)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('コード違いは日本語のメッセージ付きのエラー', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'INVALID_OTP' }, { status: 400 }))
    await expect(signInWithOtp('a@example.com', '000000')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_OTP',
      message: 'コードが正しくありません',
    })
  })

  it('未ログインの get-session（null 本文）は null', async () => {
    fetchMock.mockResolvedValue(new Response('null', { status: 200 }))
    expect(await getSession()).toBeNull()
  })
})
