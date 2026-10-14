import { create } from 'zustand'
import { getStorage } from '../storage'
import { startSync, stopSync, useSyncStore } from '../sync'
import { HttpTransport } from '../sync/httpTransport'
import {
  clearAccessToken,
  getAccessToken,
  getSession,
  sendSignInOtp,
  signInWithOtp,
  signOut as apiSignOut,
  type AuthUser,
} from './client'

/**
 * ログイン状態。
 * - unavailable: 同期サーバーが無い環境（vite 単体の開発サーバー等）。ローカル保存だけで動く
 * - signedOut / signedIn: 同期サーバーがある。ログインすると同期エンジンが動く
 */
export type AuthStatus = 'unknown' | 'unavailable' | 'signedOut' | 'signedIn'

/** この端末が最後に同期したアカウントのメール（別アカウントでのログイン時に注意を出す） */
const META_LAST_EMAIL = 'syncUserEmail'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  /** セッションが切れてログアウト状態に戻った（再ログインを促す） */
  expired: boolean
  /** この端末が前回同期していたアカウントのメール。無ければ null */
  previousEmail: string | null
  init(): Promise<void>
  sendCode(email: string): Promise<void>
  verifyCode(email: string, code: string): Promise<void>
  signOut(): Promise<void>
}

/** 同期サーバーがあるか（/api/health が答えるか） */
async function serverAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true
  } catch {
    return false
  }
}

async function beginSync(user: AuthUser): Promise<void> {
  await getStorage().setMeta(META_LAST_EMAIL, user.email)
  await startSync(new HttpTransport({ baseUrl: '', getToken: () => getAccessToken() }), user.id)
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  user: null,
  expired: false,
  previousEmail: null,

  async init() {
    if (!(await serverAvailable())) {
      set({ status: 'unavailable', user: null })
      return
    }
    const previousEmail = (await getStorage().getMeta(META_LAST_EMAIL)) ?? null
    try {
      const user = await getSession()
      set({ status: user ? 'signedIn' : 'signedOut', user, previousEmail })
      if (user) await beginSync(user)
    } catch {
      // 認証サーバーに届かない。ローカル保存だけで続ける（次回起動時に再確認）
      set({ status: 'signedOut', user: null, previousEmail })
    }
  },

  async sendCode(email) {
    await sendSignInOtp(email)
  },

  async verifyCode(email, code) {
    const user = await signInWithOtp(email, code)
    set({ status: 'signedIn', user, expired: false, previousEmail: user.email })
    await beginSync(user)
  },

  async signOut() {
    stopSync()
    set({ status: 'signedOut', user: null, expired: false })
    await apiSignOut()
  },
}))

// 同期中にセッションが切れたら（401）、ログアウト状態に戻して再ログインを促す。
// ローカルのデータと送信待ちは残るので、同じアカウントで入り直せば続きから送られる。
useSyncStore.subscribe((state, prev) => {
  if (state.status.phase === 'unauthorized' && prev.status.phase !== 'unauthorized') {
    if (useAuthStore.getState().status !== 'signedIn') return
    stopSync()
    clearAccessToken()
    useAuthStore.setState({ status: 'signedOut', user: null, expired: true })
  }
})
