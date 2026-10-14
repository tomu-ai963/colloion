import {
  SyncAuthError,
  SyncForbiddenError,
  SyncQuotaError,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncTransport,
} from './protocol'

export interface HttpTransportOptions {
  /** API のオリジン。同一オリジン配信なら空文字（相対パス） */
  baseUrl: string
  /** 認証トークン（Neon Auth の JWT）。未ログインなら null */
  getToken(): Promise<string | null>
  fetch?: typeof fetch
}

/** サーバーが返したエラー（401・403・507 以外）。エンジンはこれを受けたら間隔を空けて再試行する */
export class SyncHttpError extends Error {
  constructor(readonly status: number) {
    super(`同期サーバーがエラーを返しました（${status}）`)
    this.name = 'SyncHttpError'
  }
}

/** Worker の /api/sync/* を叩く通信層 */
export class HttpTransport implements SyncTransport {
  constructor(private opts: HttpTransportOptions) {}

  push(req: PushRequest): Promise<PushResponse> {
    return this.request<PushResponse>('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  }

  pull(since: number): Promise<PullResponse> {
    return this.request<PullResponse>(`/api/sync/pull?since=${since}`, { method: 'GET' })
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.opts.getToken()
    if (!token) throw new SyncAuthError()
    const doFetch = this.opts.fetch ?? fetch
    // 通信自体の失敗は TypeError のまま投げる（エンジンが offline と判断する）
    const res = await doFetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (res.status === 401) throw new SyncAuthError()
    if (res.status === 403) throw new SyncForbiddenError()
    if (res.status === 507) throw new SyncQuotaError()
    if (!res.ok) throw new SyncHttpError(res.status)
    return (await res.json()) as T
  }
}
