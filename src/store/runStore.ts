import { create } from 'zustand'
import { electrochemicalEquivalent, METALS } from '../core/metals'
import type { Batch } from '../core/model'
import {
  addMark,
  computeMeasured,
  createSession,
  cutSegment,
  endSession,
  expectedReversals,
  pauseSession,
  recoverAsEnded,
  recoverAsEnergized,
  recoverAsStopped,
  resumeSession,
  reversalCount,
  verifyTotalCoulombs,
  type Mark,
  type Session,
} from '../core/session'
import { getStorage } from '../storage'
import { useAppStore } from './appStore'

const storage = getStorage()

const PERSIST_INTERVAL_MS = 10_000

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`

export type RecoveryChoice = 'energized' | 'stopped' | 'ended' | 'discard'

export interface RunState {
  /** アクティブなセッション（running / paused）。null なら編集画面 */
  session: Session | null
  batch: Batch | null
  /** 表示用の現在時刻。計時の真実は常に Date.now() との差分 */
  now: number
  /** 直近の反転案内の時刻（バナー表示用。反転は電源側の機能で、アプリは知らせるだけ） */
  reversalNoticeAt: number | null
  /** 起動時整合性チェックの乖離警告 */
  integrityWarning: { stored: number; recomputed: number } | null
  /** 起動時に見つかった未終了セッション（復帰ダイアログ表示用） */
  recovery: { session: Session; batch: Batch | null } | null

  start(batch: Batch): Promise<void>
  tick(): void
  pause(): Promise<void>
  resume(): Promise<void>
  changeSettings(currentMa: number, voltageV: number): Promise<void>
  recordMark(mark: Omit<Mark, 'at'>): Promise<void>
  /** 終了して Batch.measured に書き戻す。戻り値は更新後の measured ppm */
  end(aborted?: boolean): Promise<number | null>
  dismissReversalNotice(): void

  checkRecovery(): Promise<void>
  applyRecovery(choice: RecoveryChoice): Promise<void>
}

async function persist(session: Session): Promise<Session> {
  const stamped = { ...session, updatedAt: Date.now() }
  await storage.saveSession(stamped)
  return stamped
}

/** セッション終了 → Batch.measured への書き戻し（computed は上書きしない） */
async function writeBackMeasured(session: Session, batch: Batch | null): Promise<number | null> {
  const target = batch ?? useAppStore.getState().batches.find((b) => b.id === session.batchId) ?? null
  if (!target || session.endedAt === undefined) return null
  const metal = METALS[target.electrode.anode]
  const m = computeMeasured(
    session,
    session.endedAt,
    electrochemicalEquivalent(metal),
    target.power.eta,
    target.water.volumeMl,
  )
  await useAppStore.getState().applyMeasured(target.id, {
    ...m,
    etaPct: target.power.eta,
    sessionId: session.id,
  })
  return m.ppm
}

let lastPersistAt = 0

export const useRunStore = create<RunState>((set, get) => ({
  session: null,
  batch: null,
  now: Date.now(),
  reversalNoticeAt: null,
  integrityWarning: null,
  recovery: null,

  async start(batch) {
    const now = Date.now()
    const session = createSession(newId(), batch.id, now, batch.power.currentMa, batch.power.voltageV)
    const saved = await persist(session)
    lastPersistAt = now
    set({ session: saved, batch, now, reversalNoticeAt: null, integrityWarning: null })
  },

  tick() {
    const { session, batch } = get()
    const now = Date.now()
    if (!session) {
      set({ now })
      return
    }
    let next = session

    // 反転時刻の検知: 通電経過から「本来の反転回数」を求め、不足分の区間を切る。
    // 時刻ベースなのでスリープ復帰後も自己修復する（1 tick に 1 回ずつ追いつく）。
    const intervalMin = batch?.power.reversalMin ?? 0
    if (next.status === 'running' && intervalMin > 0) {
      if (expectedReversals(next, now, intervalMin) > reversalCount(next)) {
        next = cutSegment(next, now, 'reversal')
        set({ reversalNoticeAt: now })
      }
    }

    // 10 秒ごとの定期永続化（描画 tick に相乗り）
    if (next !== session || now - lastPersistAt >= PERSIST_INTERVAL_MS) {
      lastPersistAt = now
      void persist(next).then((saved) => {
        // tick は高頻度なので、保存スタンプの反映は同一セッションのときだけ
        if (get().session?.id === saved.id) set({ session: saved })
      })
    }
    set({ session: next, now })
  },

  async pause() {
    const { session } = get()
    if (!session) return
    const saved = await persist(pauseSession(session, Date.now()))
    set({ session: saved })
  },

  async resume() {
    const { session } = get()
    if (!session) return
    const saved = await persist(resumeSession(session, Date.now()))
    set({ session: saved })
  },

  async changeSettings(currentMa, voltageV) {
    const { session } = get()
    if (!session || session.status !== 'running') return
    const open = session.segments[session.segments.length - 1]
    const reason = open && currentMa !== open.currentMa ? 'current_change' : 'voltage_change'
    const saved = await persist(cutSegment(session, Date.now(), reason, { currentMa, voltageV }))
    set({ session: saved })
  },

  async recordMark(mark) {
    const { session } = get()
    if (!session) return
    const saved = await persist(addMark(session, { ...mark, at: Date.now() }))
    set({ session: saved })
  },

  async end(aborted = false) {
    const { session, batch } = get()
    if (!session) return null
    const ended = endSession(session, Date.now(), aborted ? 'aborted' : 'completed')
    await persist(ended)
    const ppm = aborted ? null : await writeBackMeasured(ended, batch)
    set({ session: null, batch: null, reversalNoticeAt: null, integrityWarning: null })
    return ppm
  },

  dismissReversalNotice: () => set({ reversalNoticeAt: null }),

  async checkRecovery() {
    const sessions = await storage.listSessions()
    const pending = sessions.find((s) => s.status === 'running' || s.status === 'paused')
    if (!pending) return
    const check = verifyTotalCoulombs(pending)
    const batch = useAppStore.getState().batches.find((b) => b.id === pending.batchId) ?? null
    set({
      recovery: { session: pending, batch },
      integrityWarning: check.ok ? null : { stored: check.stored, recomputed: check.recomputed },
    })
  },

  async applyRecovery(choice) {
    const { recovery } = get()
    if (!recovery) return
    const now = Date.now()
    const { session, batch } = recovery

    if (choice === 'discard') {
      await persist(endSession(session, session.updatedAt, 'aborted'))
      set({ recovery: null })
      return
    }
    if (choice === 'ended') {
      const ended = recoverAsEnded(session)
      await persist(ended)
      await writeBackMeasured(ended, batch)
      set({ recovery: null })
      return
    }
    const resumed =
      choice === 'energized' ? recoverAsEnergized(session, now) : recoverAsStopped(session, now)
    const running = resumed.status === 'paused' ? resumeSession(resumed, now) : resumed
    const saved = await persist(running)
    lastPersistAt = now
    set({ recovery: null, session: saved, batch, now })
  },
}))
