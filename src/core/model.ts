import type { MetalSymbol, Route } from './metals'

/** コロイド（粒子分散）かイオン溶液か */
export type Mode = 'colloid' | 'ion'

export type WaterType = '蒸留水' | 'RO水' | '精製水' | '超純水'

export interface WaterConfig {
  volumeMl: number
  type: WaterType
  initialTds: number
  tempC: number
}

export interface ElectrodeConfig {
  anode: MetalSymbol
  cathode: string
  purity: '99.9%' | '99.99%' | '99.999%'
  areaCm2: number
  gapMm: number
  route: Route
}

export type AdditiveRole = '電解質' | '還元剤' | '保護剤 / 分散剤' | 'pH 調整'
export type AdditiveTiming = '通電前' | '通電中' | '通電後'
export type AdditiveMethod = 'direct' | 'stock'

export interface Additive {
  reagentId: string | null
  name: string
  mw: number
  role: AdditiveRole
  method: AdditiveMethod
  /** direct: 秤量 [mg] */
  massMg?: number
  /** stock: 分注元と滴数 */
  stockId?: string
  drops?: number
  doseMl?: number
  finalMmolPerL?: number
  timing: AdditiveTiming
}

export interface PowerConfig {
  mode: 'CC' | 'CV'
  currentMa: number
  voltageV: number
  durationSec: number
  /** 電流効率 [%]（Mg は 100 超） */
  eta: number
  /** 極性反転間隔 [分]。0 = なし */
  reversalMin: number
}

export type Verdict = '良' | '凝集' | '粒径大' | '析出' | '—'

export interface BatchResult {
  measuredTds?: number
  measuredPh?: number
  colorNote?: string
  verdict?: Verdict
  photoBlobId?: string
}

/**
 * 保存時点の計算値スナップショット。
 * 後日ロジックを修正しても過去の記録が書き換わらないよう、値を固定する。
 */
export interface ComputedSnapshot {
  mg: number
  ppm: number
  coulombs: number
  currentDensity: number
}

/**
 * 通電セッションの積算電荷に基づく実測ベースの値。
 * computed（設定値ベースの理論値）は上書きせず、両方を残して η 補正の材料にする。
 * etaPct はセッション終了時点の仮値（実測 TDS は終了後に測るため確定ではない）。
 */
export interface MeasuredSnapshot {
  coulombs: number
  mg: number
  ppm: number
  etaPct: number
  sessionId: string
}

export interface Batch {
  id: string
  /** 表示用バッチ番号 例: 2026-0801-01 */
  label: string
  createdAt: string // ISO 8601
  mode: Mode
  water: WaterConfig
  electrode: ElectrodeConfig
  additives: Additive[]
  power: PowerConfig
  result?: BatchResult
  computed: ComputedSnapshot
  /** Run Mode のセッション積算から書き戻される（computed は不変のまま） */
  measured?: MeasuredSnapshot
}

export interface Reagent {
  id: string
  name: string
  formula: string
  mw: number
  purityPct: number
  role: AdditiveRole
}

export interface Stock {
  id: string
  reagentId: string
  /** 母液は濃度 [mol/L] で保持する */
  molarity: number
  preparedAt: string // ISO 8601
  volumeRemainingMl: number
}

/** スポイト。1滴の体積は器具に紐づく（試薬ではなく） */
export interface Pipette {
  id: string
  name: string
  mlPer20Drops: number
}
