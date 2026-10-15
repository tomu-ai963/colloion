/**
 * colloion のサービスワーカー（オフラインでも開けるように）。
 *
 * 記録は IndexedDB にあるので、画面（index.html と /assets/*）さえ手元にあればオフラインで使える。
 * - 画面の取得（ナビゲーション）: ネットワーク優先。届かない・NETWORK_TIMEOUT_MS を超えたら保存済みの index.html
 * - index.html を保存するときは、それが参照する /assets/*（ハッシュ付き・不変）を先にそろえる。
 *   そろわなければ保存しない（オフラインで開いたときに JS・CSS が欠けないように）。
 *   参照されなくなった古い /assets/* はそのときに消す
 * - /assets/*: キャッシュ優先（ファイル名が変わるので古いものが返ることはない）
 * - manifest・アイコン: キャッシュを返しつつ裏で取り直す
 * - /api/*（同期・認証）と GET 以外・他のオリジン: 触らない（常にネットワーク）
 *
 * アプリの更新は index.html（ネットワーク優先）で届くので、このファイルは中身の規則を
 * 変えたときだけ書き換え、CACHE の版を上げる（古いキャッシュは activate で消える）。
 * public/ に置いてあり、ビルドではそのまま /sw.js として配信される。テストは src/pwa/sw.test.ts
 */

const CACHE = 'colloion-v1'
const SHELL = '/'
const STATIC = [
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
]
const NETWORK_TIMEOUT_MS = 4000

/** index.html が参照する /assets/* のパス */
function assetPaths(html) {
  const out = new Set()
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) out.add(m[1])
  return [...out]
}

/** index.html と、それが参照する /assets/* をそろえて保存する。そろわなければ例外（古い版が残る） */
async function storeShell(cache, html) {
  const assets = assetPaths(html)
  await Promise.all(
    assets.map(async (path) => {
      if (await cache.match(path)) return
      const res = await fetch(path)
      if (!res.ok) throw new Error(`asset ${path}: ${res.status}`)
      await cache.put(path, res)
    }),
  )
  await cache.put(SHELL, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  const keep = new Set(assets)
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(req)
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

const isHtml = (res) => (res.headers.get('Content-Type') ?? '').includes('text/html')

async function navigate(event) {
  const cache = await caches.open(CACHE)
  try {
    const res = await withTimeout(fetch(event.request), NETWORK_TIMEOUT_MS)
    if (res.ok && isHtml(res)) {
      const html = await res.clone().text()
      event.waitUntil(storeShell(cache, html).catch(() => {}))
    }
    return res
  } catch {
    return (await cache.match(SHELL)) ?? Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const res = await fetch(request)
  if (res.ok) await cache.put(request, res.clone())
  return res
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(event.request)
  const refresh = fetch(event.request).then(async (res) => {
    if (res.ok) await cache.put(event.request, res.clone())
    return res
  })
  if (cached) {
    event.waitUntil(refresh.catch(() => {}))
    return cached
  }
  return refresh
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(STATIC)
      const res = await fetch(SHELL, { cache: 'no-cache' })
      if (res.ok && isHtml(res)) await storeShell(cache, await res.text())
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('colloion-') && name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') {
    event.respondWith(navigate(event))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req))
  } else if (STATIC.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event))
  }
})
