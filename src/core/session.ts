/**
 * 通電セッション（Run Mode）の計時・積算ロジック。
 *
 * 設計の要点:
 * - 経過時間・電荷は setInterval のカウントではなく「時刻の差分」から計算する。
 *   ここの関数はすべて純粋で、現在時刻 nowMs を引数に取る（Date.now() を呼ばない）。
 *   バックグラウンド throttle やスリープで tick が欠落しても値は狂わない。
 * - 区間（Segment）は追記のみ（append-only）。閉じた区間は書き換えない。
 *   唯一の状態遷移は「開いている区間を一度だけ閉じる」こと。
 * - 一時停止は開いている区間を閉じて行う。したがって区間は常に通電中の
 *   連続した時間だけを覆い、停止時間が電荷に混入しない。
 * - totalCoulombs は閉じた区間の合計。segments から再計算できるが冗長に保存し、
 *   起動時に verifyTotalCoulombs で整合性を確認する。
 */

export type SegmentReason =
  | 'start'
  | 'current_change'
  | 'voltage_change'
  | 'reversal'
  | 'resume'
  | 'manual'

export interface Segment {
  index: number
  /** epoch ms */
  startedAt: number
  /** epoch ms。未設定 = 開いている区間 */
  endedAt?: number
  currentMa: number
  voltageV?: number
  /** 閉じた区間で確定する電荷 [C]。開いている間は 0 のまま（ライブ値は関数で計算） */
  coulombs: number
  reason: SegmentReason
}

export type MarkKind = 'note' | 'temp' | 'ph' | 'observation'

export interface Mark {
  /** epoch ms */
  at: number
  kind: MarkKind
  value?: number
  text?: string
}

export type SessionStatus = 'running' | 'paused' | 'completed' | 'aborted'

export interface Session {
  id: string
  batchId: string
  /** epoch ms */
  startedAt: number
  endedAt?: number
  status: SessionStatus
  segments: Segment[]
  marks: Mark[]
  /** 閉じた区間の電荷合計 [C]（冗長保存。verifyTotalCoulombs で検証） */
  totalCoulombs: number
  /** 一時停止していた累積時間 [ms] */
  pausedDurationMs: number
  /** 一時停止中のみ: 停止した時刻 */
  pausedAt?: number
  /** 最終書き込み時刻。クラッシュ復帰の「最後に生きていた時刻」として使う */
  updatedAt: number
}

const msToCoulombs = (currentMa: number, ms: number): number =>
  (Math.max(0, currentMa) / 1000) * (Math.max(0, ms) / 1000)

export function createSession(
  id: string,
  batchId: string,
  nowMs: number,
  currentMa: number,
  voltageV?: number,
): Session {
  return {
    id,
    batchId,
    startedAt: nowMs,
    status: 'running',
    segments: [
      { index: 0, startedAt: nowMs, currentMa, voltageV, coulombs: 0, reason: 'start' },
    ],
    marks: [],
    totalCoulombs: 0,
    pausedDurationMs: 0,
    updatedAt: nowMs,
  }
}

/** 開いている区間（running 中は常に1つ、それ以外は undefined） */
export function openSegment(session: Session): Segment | undefined {
  const last = session.segments[session.segments.length - 1]
  return last && last.endedAt === undefined ? last : undefined
}

/** 区間の電荷 [C]。閉じた区間は確定値、開いている区間は nowMs までの時刻差分から */
export function segmentCoulombs(segment: Segment, nowMs: number): number {
  if (segment.endedAt !== undefined) return segment.coulombs
  return msToCoulombs(segment.currentMa, nowMs - segment.startedAt)
}

/** 区間の長さ [ms] */
export function segmentDurationMs(segment: Segment, nowMs: number): number {
  return Math.max(0, (segment.endedAt ?? nowMs) - segment.startedAt)
}

/** セッション全体の積算電荷 [C] = 確定分 + 開いている区間のライブ分 */
export function sessionCoulombs(session: Session, nowMs: number): number {
  const open = openSegment(session)
  return session.totalCoulombs + (open ? segmentCoulombs(open, nowMs) : 0)
}

/** 通電していた経過時間 [ms]（一時停止分を差し引く） */
export function activeElapsedMs(session: Session, nowMs: number): number {
  const end =
    session.endedAt ?? (session.status === 'paused' ? (session.pausedAt ?? nowMs) : nowMs)
  return Math.max(0, end - session.startedAt - session.pausedDurationMs)
}

/** 開いている区間を atMs で閉じる（電荷を確定し totalCoulombs に加算） */
function closeOpenSegment(session: Session, atMs: number): Session {
  const open = openSegment(session)
  if (!open) return session
  const closed: Segment = {
    ...open,
    endedAt: atMs,
    coulombs: msToCoulombs(open.currentMa, atMs - open.startedAt),
  }
  return {
    ...session,
    segments: [...session.segments.slice(0, -1), closed],
    totalCoulombs: session.totalCoulombs + closed.coulombs,
  }
}

/**
 * 区間を切る: 開いている区間を閉じ、新しい設定で新区間を開く。
 * 電流・電圧の変更、極性反転、手動区切りに使う。running 以外では何もしない。
 */
export function cutSegment(
  session: Session,
  nowMs: number,
  reason: Exclude<SegmentReason, 'start' | 'resume'>,
  patch: { currentMa?: number; voltageV?: number } = {},
): Session {
  if (session.status !== 'running') return session
  const open = openSegment(session)
  if (!open) return session
  const closedSession = closeOpenSegment(session, nowMs)
  const next: Segment = {
    index: open.index + 1,
    startedAt: nowMs,
    currentMa: patch.currentMa ?? open.currentMa,
    voltageV: patch.voltageV ?? open.voltageV,
    coulombs: 0,
    reason,
  }
  return { ...closedSession, segments: [...closedSession.segments, next], updatedAt: nowMs }
}

/** 一時停止: 開いている区間を閉じる。停止中は経過時間・電荷とも進まない */
export function pauseSession(session: Session, nowMs: number): Session {
  if (session.status !== 'running') return session
  return {
    ...closeOpenSegment(session, nowMs),
    status: 'paused',
    pausedAt: nowMs,
    updatedAt: nowMs,
  }
}

/** 再開: 停止時間を pausedDurationMs に積み、reason 'resume' で新区間を開く */
export function resumeSession(session: Session, nowMs: number): Session {
  if (session.status !== 'paused' || session.pausedAt === undefined) return session
  const last = session.segments[session.segments.length - 1]
  const next: Segment = {
    index: (last?.index ?? -1) + 1,
    startedAt: nowMs,
    currentMa: last?.currentMa ?? 0,
    voltageV: last?.voltageV,
    coulombs: 0,
    reason: 'resume',
  }
  return {
    ...session,
    status: 'running',
    pausedDurationMs: session.pausedDurationMs + (nowMs - session.pausedAt),
    pausedAt: undefined,
    segments: [...session.segments, next],
    updatedAt: nowMs,
  }
}

/** 終了: 開いている区間を閉じ、endedAt を確定する */
export function endSession(
  session: Session,
  nowMs: number,
  status: 'completed' | 'aborted' = 'completed',
): Session {
  if (session.status === 'completed' || session.status === 'aborted') return session
  if (session.status === 'paused' && session.pausedAt !== undefined) {
    // 停止中に終了 → 停止していた時間も pausedDurationMs に確定
    return {
      ...session,
      status,
      endedAt: nowMs,
      pausedDurationMs: session.pausedDurationMs + (nowMs - session.pausedAt),
      pausedAt: undefined,
      updatedAt: nowMs,
    }
  }
  return { ...closeOpenSegment(session, nowMs), status, endedAt: nowMs, updatedAt: nowMs }
}

export function addMark(session: Session, mark: Mark): Session {
  return { ...session, marks: [...session.marks, mark], updatedAt: mark.at }
}

/* ---------- クラッシュ復帰 ---------- */

/** 復帰: 中断中も通電していた扱い。開いている区間が空白時間をそのまま覆う */
export function recoverAsEnergized(session: Session, nowMs: number): Session {
  return { ...session, updatedAt: nowMs }
}

/**
 * 復帰: 中断中は止まっていた扱い。
 * 最終書き込み時刻 updatedAt で区間を閉じ、空白を停止時間として積み、新区間を開く。
 */
export function recoverAsStopped(session: Session, nowMs: number): Session {
  const lastAlive = session.updatedAt
  if (session.status === 'paused') {
    // 停止中に落ちた場合: 空白も停止時間として積む
    return resumeSession({ ...session, pausedAt: session.pausedAt ?? lastAlive }, nowMs)
  }
  const closed = closeOpenSegment(session, lastAlive)
  const last = closed.segments[closed.segments.length - 1]
  const next: Segment = {
    index: (last?.index ?? -1) + 1,
    startedAt: nowMs,
    currentMa: last?.currentMa ?? 0,
    voltageV: last?.voltageV,
    coulombs: 0,
    reason: 'resume',
  }
  return {
    ...closed,
    pausedDurationMs: closed.pausedDurationMs + (nowMs - lastAlive),
    segments: [...closed.segments, next],
    updatedAt: nowMs,
  }
}

/** 復帰せず終了扱い: 最後に生きていた時刻を endedAt として完了させる */
export function recoverAsEnded(session: Session): Session {
  return endSession(session, session.updatedAt, 'completed')
}

/* ---------- 検証・派生値 ---------- */

/** totalCoulombs（冗長保存）と閉区間合計の整合性チェック */
export function verifyTotalCoulombs(session: Session): {
  ok: boolean
  stored: number
  recomputed: number
} {
  const recomputed = session.segments
    .filter((s) => s.endedAt !== undefined)
    .reduce((sum, s) => sum + s.coulombs, 0)
  return { ok: Math.abs(recomputed - session.totalCoulombs) < 1e-6, stored: session.totalCoulombs, recomputed }
}

/** 時刻 tMs までの積算電荷 [C]（グラフの曲線生成用） */
export function coulombsAt(session: Session, tMs: number): number {
  let sum = 0
  for (const seg of session.segments) {
    if (seg.startedAt >= tMs) break
    const end = Math.min(seg.endedAt ?? tMs, tMs)
    sum += msToCoulombs(seg.currentMa, end - seg.startedAt)
  }
  return sum
}

/** 任意の時刻 tMs までの通電経過 [ms]（マークのグラフ位置決め用） */
export function activeElapsedAtTime(session: Session, tMs: number): number {
  let acc = 0
  for (const seg of session.segments) {
    if (tMs <= seg.startedAt) break
    acc += Math.min(seg.endedAt ?? tMs, tMs) - seg.startedAt
  }
  return acc
}

/** 投入電力量 [Wh]。電圧未記録の区間は 0 として扱う（V × C = J, /3600 で Wh） */
export function energyWh(session: Session, nowMs: number): number {
  return session.segments.reduce(
    (sum, seg) => sum + (seg.voltageV ?? 0) * segmentCoulombs(seg, nowMs),
    0,
  ) / 3600
}

/** これまでに実施された極性反転の回数（reversal 区間の数） */
export function reversalCount(session: Session): number {
  return session.segments.filter((s) => s.reason === 'reversal').length
}

/** 通電経過から本来行われているはずの反転回数。intervalMin<=0 は反転なし */
export function expectedReversals(session: Session, nowMs: number, intervalMin: number): number {
  if (intervalMin <= 0) return 0
  return Math.floor(activeElapsedMs(session, nowMs) / (intervalMin * 60_000))
}

/** 次の反転時刻までの残り [ms]。反転なし設定は null */
export function msUntilReversal(session: Session, nowMs: number, intervalMin: number): number | null {
  if (intervalMin <= 0) return null
  const interval = intervalMin * 60_000
  return interval - (activeElapsedMs(session, nowMs) % interval)
}

/** 電極表示の極性。反転回数が奇数なら入れ替わっている */
export function polarityFlipped(session: Session): boolean {
  return reversalCount(session) % 2 === 1
}

/** セッションの平均電流 [mA]（通電時間ベース） */
export function averageCurrentMa(session: Session, nowMs: number): number {
  const activeMs = activeElapsedMs(session, nowMs)
  if (activeMs <= 0) return 0
  return (sessionCoulombs(session, nowMs) / (activeMs / 1000)) * 1000
}

export interface MeasuredResult {
  coulombs: number
  mg: number
  ppm: number
}

/** セッション積算電荷 → 実測ベースの溶出量・濃度（η は保存時点の仮値） */
export function computeMeasured(
  session: Session,
  nowMs: number,
  equivalentMgPerC: number,
  etaPct: number,
  volumeMl: number,
): MeasuredResult {
  const coulombs = sessionCoulombs(session, nowMs)
  const mg = Math.max(0, equivalentMgPerC) * coulombs * (Math.max(0, etaPct) / 100)
  const vL = volumeMl / 1000
  return { coulombs, mg, ppm: vL > 0 ? mg / vL : 0 }
}

/** グラフ描画用の間引き。先頭と末尾は必ず残す */
export function decimate<T>(points: T[], maxPoints: number): T[] {
  if (maxPoints < 2 || points.length <= maxPoints) return points
  const step = (points.length - 1) / (maxPoints - 1)
  const out: T[] = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * step)]!)
  }
  return out
}

export interface ChartPoint {
  /** 通電経過 [ms]（一時停止を除いた軸） */
  elapsedMs: number
  ppmCoulombs: number
  currentMa: number
  voltageV?: number
}

/**
 * グラフ用の系列。区間内では電流一定＝電荷が線形なので、
 * 各区間の始点・終点だけで正確な折れ線になる（10800 点を舐めない）。
 * それでも区間数が多い場合に備えて maxPoints で間引く。
 */
export function chartSeries(session: Session, nowMs: number, maxPoints = 240): ChartPoint[] {
  const points: ChartPoint[] = []
  let activeMs = 0
  let charge = 0
  for (const seg of session.segments) {
    const endMs = seg.endedAt ?? nowMs
    const durMs = Math.max(0, endMs - seg.startedAt)
    points.push({ elapsedMs: activeMs, ppmCoulombs: charge, currentMa: seg.currentMa, voltageV: seg.voltageV })
    charge += segmentCoulombs(seg, nowMs)
    activeMs += durMs
    points.push({ elapsedMs: activeMs, ppmCoulombs: charge, currentMa: seg.currentMa, voltageV: seg.voltageV })
  }
  return decimate(points, maxPoints)
}

/** 反転が起きた位置（通電経過 ms）の一覧。グラフの縦マーカー用 */
export function reversalPositionsMs(session: Session): number[] {
  const out: number[] = []
  let activeMs = 0
  for (const seg of session.segments) {
    if (seg.reason === 'reversal') out.push(activeMs)
    if (seg.endedAt !== undefined) activeMs += seg.endedAt - seg.startedAt
  }
  return out
}
