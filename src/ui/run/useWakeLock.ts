import { useCallback, useEffect, useRef, useState } from 'react'

export type WakeLockState = 'on' | 'off' | 'unsupported' | 'failed'

/**
 * 画面スリープ抑止（Screen Wake Lock API）。
 * - 非対応・取得失敗では例外で画面を壊さず、状態として返す
 * - Wake Lock は visibility 変化で解放されるため、タブ復帰時に再取得する
 */
export function useWakeLock(active: boolean): { state: WakeLockState; toggle(): void } {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const [state, setState] = useState<WakeLockState>(supported ? 'on' : 'unsupported')
  const sentinel = useRef<WakeLockSentinel | null>(null)
  const wanted = useRef(true)

  const release = useCallback(() => {
    void sentinel.current?.release().catch(() => undefined)
    sentinel.current = null
  }, [])

  const acquire = useCallback(async () => {
    if (!supported || !wanted.current) return
    try {
      const lock = await navigator.wakeLock.request('screen')
      sentinel.current = lock
      lock.addEventListener('release', () => {
        sentinel.current = null
      })
      setState('on')
    } catch {
      setState('failed')
    }
  }, [supported])

  useEffect(() => {
    if (!active || !supported) return
    void acquire()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wanted.current && !sentinel.current) {
        void acquire()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      release()
    }
  }, [active, supported, acquire, release])

  const toggle = useCallback(() => {
    if (!supported) return
    if (wanted.current) {
      wanted.current = false
      release()
      setState('off')
    } else {
      wanted.current = true
      void acquire()
    }
  }, [supported, acquire, release])

  return { state, toggle }
}
