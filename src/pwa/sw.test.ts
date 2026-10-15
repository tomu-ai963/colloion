// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * public/sw.js をそのまま読み込み、偽の self・caches・fetch の上でイベントを流して確かめる。
 * サーバーは「ファイルの表」と「オンラインか」だけを持つ。
 */
const SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
const ORIGIN = 'https://colloion.tomu-ai.dev'

type Body = { body: string; type: string }

const html = (js: string, css: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${js}"></script>` +
  `<link rel="stylesheet" crossorigin href="${css}"><link rel="manifest" href="/manifest.webmanifest" /></head>` +
  `<body><div id="root"></div></body></html>`

const STATIC = [
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
]

const urlOf = (input: string | { url: string }) =>
  new URL(typeof input === 'string' ? input : input.url, ORIGIN)

class FakeCache {
  entries = new Map<string, { body: ArrayBuffer; status: number; headers: [string, string][] }>()
  constructor(private fetcher: (input: string) => Promise<Response>) {}
  async match(req: string | { url: string }) {
    const e = this.entries.get(urlOf(req).href)
    return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined
  }
  async put(req: string | { url: string }, res: Response) {
    this.entries.set(urlOf(req).href, {
      body: await res.arrayBuffer(),
      status: res.status,
      headers: [...res.headers.entries()],
    })
  }
  async addAll(list: string[]) {
    for (const u of list) {
      const res = await this.fetcher(u)
      if (!res.ok) throw new TypeError(`addAll ${u}`)
      await this.put(u, res)
    }
  }
  async delete(req: string | { url: string }) {
    return this.entries.delete(urlOf(req).href)
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }
  paths() {
    return [...this.entries.keys()].map((u) => new URL(u).pathname).sort()
  }
}

function setup() {
  const files = new Map<string, Body>()
  const server = { online: true, hang: false, files, requests: [] as string[] }
  for (const p of STATIC) files.set(p, { body: `static ${p}`, type: 'image/png' })

  const fetcher = async (input: string | { url: string }): Promise<Response> => {
    const url = urlOf(input)
    server.requests.push(url.pathname)
    if (server.hang) return new Promise<Response>(() => {})
    if (!server.online) throw new TypeError('Failed to fetch')
    const f = files.get(url.pathname)
    if (!f) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    return new Response(f.body, { status: 200, headers: { 'Content-Type': f.type } })
  }

  const stores = new Map<string, FakeCache>()
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new FakeCache(fetcher))
      return stores.get(name)!
    },
    async keys() {
      return [...stores.keys()]
    },
    async delete(name: string) {
      return stores.delete(name)
    },
  }

  const handlers: Record<string, (e: unknown) => void> = {}
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers[type] = fn
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetcher)

  /** install / activate を流して、waitUntil の完了まで待つ */
  const lifecycle = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = []
    handlers[type]!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }

  /** fetch イベント。サービスワーカーが応答しなければ null（ブラウザがそのままネットワークへ） */
  const request = async (path: string, opts: { mode?: string; method?: string; origin?: string } = {}) => {
    let responded: Promise<Response> | null = null
    const waits: Promise<unknown>[] = []
    handlers.fetch!({
      request: { url: (opts.origin ?? ORIGIN) + path, method: opts.method ?? 'GET', mode: opts.mode ?? 'cors' },
      respondWith: (p: Promise<Response>) => {
        responded = p
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    if (!responded) return null
    const res = await (responded as Promise<Response>)
    await Promise.all(waits)
    return res
  }

  const deploy = (version: string) => {
    files.set(`/assets/index-${version}.js`, { body: `js ${version}`, type: 'text/javascript' })
    files.set(`/assets/index-${version}.css`, { body: `css ${version}`, type: 'text/css' })
    files.set('/', {
      body: html(`/assets/index-${version}.js`, `/assets/index-${version}.css`),
      type: 'text/html; charset=utf-8',
    })
  }

  return { server, files, stores, caches, lifecycle, request, deploy, cache: () => stores.get('colloion-v1')! }
}

describe('サービスワーカー', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.deploy('a1')
  })
  afterEach(() => vi.useRealTimers())

  it('install で画面（index.html と参照する JS・CSS）とアイコンを保存し、オフラインでも開ける', async () => {
    await t.lifecycle('install')
    expect(t.cache().paths()).toEqual(
      ['/', '/assets/index-a1.css', '/assets/index-a1.js', ...STATIC].sort(),
    )

    t.server.online = false
    const page = await t.request('/', { mode: 'navigate' })
    expect(await page!.text()).toContain('/assets/index-a1.js')
    // SPA なので、どのパスで開いても同じ画面
    expect(await (await t.request('/anything', { mode: 'navigate' }))!.text()).toContain('index-a1')
    expect(await (await t.request('/assets/index-a1.js'))!.text()).toBe('js a1')
    expect(await (await t.request('/icons/icon-192.png'))!.text()).toBe('static /icons/icon-192.png')
  })

  it('/api/*・GET 以外・他のオリジンには触らない', async () => {
    await t.lifecycle('install')
    expect(await t.request('/api/sync/pull?since=0')).toBeNull()
    expect(await t.request('/api/health')).toBeNull()
    expect(await t.request('/api/sync/push', { method: 'POST' })).toBeNull()
    expect(await t.request('/x.js', { origin: 'https://example.com' })).toBeNull()
  })

  it('オンラインでは画面はネットワークから取り、新しい版が出たら JS・CSS をそろえて差し替え、古いものを消す', async () => {
    await t.lifecycle('install')
    t.deploy('b2')

    const page = await t.request('/', { mode: 'navigate' })
    expect(await page!.text()).toContain('index-b2')
    expect(t.cache().paths()).toEqual(['/', '/assets/index-b2.css', '/assets/index-b2.js', ...STATIC].sort())

    t.server.online = false
    expect(await (await t.request('/', { mode: 'navigate' }))!.text()).toContain('index-b2')
  })

  it('新しい版の JS・CSS がそろわなければ、保存済みの画面は古い版のまま（オフラインで欠けない）', async () => {
    await t.lifecycle('install')
    t.deploy('c3')
    t.files.delete('/assets/index-c3.css') // 配信が行き渡っていない等

    expect(await (await t.request('/', { mode: 'navigate' }))!.text()).toContain('index-c3')
    t.server.online = false
    const offline = await (await t.request('/', { mode: 'navigate' }))!.text()
    expect(offline).toContain('index-a1')
    expect(await (await t.request('/assets/index-a1.css'))!.text()).toBe('css a1')
  })

  it('ネットワークが応答しないときは 4 秒で保存済みの画面を返す', async () => {
    await t.lifecycle('install')
    vi.useFakeTimers()
    t.server.hang = true
    const pending = t.request('/', { mode: 'navigate' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await (await pending)!.text()).toContain('index-a1')
  })

  it('保存済みの画面が無いままオフラインならエラー（ブラウザの通常のオフライン表示）', async () => {
    t.server.online = false
    const res = await t.request('/', { mode: 'navigate' })
    expect(res!.type).toBe('error')
  })

  it('activate で古い版の colloion のキャッシュだけを消す', async () => {
    await t.caches.open('colloion-v0')
    await t.caches.open('other-app')
    await t.lifecycle('install')
    await t.lifecycle('activate')
    expect((await t.caches.keys()).sort()).toEqual(['colloion-v1', 'other-app'])
  })
})
