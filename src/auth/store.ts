import { create } from 'zustand'
import { startSync, stopSync } from '../sync'
import { HttpTransport } from '../sync/httpTransport'
import {
  getAccessToken,
  getSession,
  sendSignInOtp,
  signInWithOtp,
  signOut as apiSignOut,
  type AuthUser,
} from './client'

/**
 * ログイン状態。
 * - unavailable: 同期サーバーが無い配信（GitHub Pages 等）。ローカル保存だけで動く
 * - signedOut / signedIn: 同期サーバーがある。ログインすると同期エンジンが動く
 */
export type AuthStatus = 'unknown' | 'unavailable' | 'signedOut' | 'signedIn'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
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
  await startSync(new HttpTransport({ baseUrl: '', getToken: () => getAccessToken() }), user.id)
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  user: null,

  async init() {
    if (!(await serverAvailable())) {
      set({ status: 'unavailable', user: null })
      return
    }
    try {
      const user = await getSession()
      set({ status: user ? 'signedIn' : 'signedOut', user })
      if (user) await beginSync(user)
    } catch {
      // 認証サーバーに届かない。ローカル保存だけで続ける（次回起動時に再確認）
      set({ status: 'signedOut', user: null })
    }
  },

  async sendCode(email) {
    await sendSignInOtp(email)
  },

  async verifyCode(email, code) {
    const user = await signInWithOtp(email, code)
    set({ status: 'signedIn', user })
    await beginSync(user)
  },

  async signOut() {
    stopSync()
    set({ status: 'signedOut', user: null })
    await apiSignOut()
  },
}))
