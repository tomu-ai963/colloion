import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from './store'

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  useAuthStore.setState({ status: 'unknown', user: null, expired: false, previousEmail: null })
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAuthStore.init', () => {
  it('オフラインで起動したら、回線が戻ったときに確かめ直す', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await useAuthStore.getState().init()
    expect(useAuthStore.getState().status).toBe('unavailable')

    // 回線が戻った: サーバーはあるがログインしていない
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/health')) return json({ ok: true })
      if (url.endsWith('/api/auth/get-session')) return json(null)
      throw new Error(`unexpected ${url}`)
    })
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('signedOut'))
  })

  it('サーバーが無い（開発サーバー単体など）ときは確かめ直さない', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 502 }))
    await useAuthStore.getState().init()
    expect(useAuthStore.getState().status).toBe('unavailable')
    fetchMock.mockClear()
    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
