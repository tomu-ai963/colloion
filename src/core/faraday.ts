/**
 * 電解計算（ファラデーの法則）。
 *   析出量[mg] = 電気化学当量[mg/C] × 電流[A] × 時間[s] × η
 *   濃度[ppm]  = 析出量[mg] / 水量[L]   （希薄水溶液では 1 mg/L ≒ 1 ppm）
 */

export interface ElectrolysisInput {
  /** 電気化学当量 [mg/C]（metals.electrochemicalEquivalent で導出） */
  equivalentMgPerC: number
  currentMa: number
  durationSec: number
  /** 電流効率 [%]。Mg は負差効果で 100 を超えうる */
  etaPct: number
  volumeMl: number
}

export interface ElectrolysisResult {
  coulombs: number
  mg: number
  ppm: number
}

const safe = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** 積算電荷 [C] */
export function coulombs(currentMa: number, durationSec: number): number {
  return (safe(currentMa) / 1000) * safe(durationSec)
}

/** 陽極からの理論溶出量 [mg] */
export function depositedMg(equivalentMgPerC: number, charge: number, etaPct: number): number {
  return safe(equivalentMgPerC) * safe(charge) * (safe(etaPct) / 100)
}

/** 濃度 [ppm]。水量 0 のときは 0 */
export function concentrationPpm(mg: number, volumeMl: number): number {
  const vL = safe(volumeMl) / 1000
  return vL > 0 ? safe(mg) / vL : 0
}

export function computeElectrolysis(input: ElectrolysisInput): ElectrolysisResult {
  const c = coulombs(input.currentMa, input.durationSec)
  const mg = depositedMg(input.equivalentMgPerC, c, input.etaPct)
  return { coulombs: c, mg, ppm: concentrationPpm(mg, input.volumeMl) }
}

/**
 * 逆算: 目標 ppm に到達するのに必要な通電時間 [s]。
 * 不溶性電極（当量 0）や電流 0 では到達不能なので null（Infinity は返さない）。
 */
export function requiredDurationSec(
  targetPpm: number,
  params: Omit<ElectrolysisInput, 'durationSec'>,
): number | null {
  const eq = safe(params.equivalentMgPerC)
  const iA = safe(params.currentMa) / 1000
  const eta = safe(params.etaPct) / 100
  const vL = safe(params.volumeMl) / 1000
  if (eq <= 0 || iA <= 0 || eta <= 0 || vL <= 0) return null
  return (safe(targetPpm) * vL) / (eq * iA * eta)
}

/** 電流密度 [mA/cm²]。面積 0 のときは 0 */
export function currentDensity(currentMa: number, areaCm2: number): number {
  const a = safe(areaCm2)
  return a > 0 ? safe(currentMa) / a : 0
}

/**
 * 推定粒径 [nm]。電流密度と濃度からの経験的な近似で、
 * TEM / DLS の測定値ではない（README 参照）。
 */
export function estimatedParticleNm(cdMaPerCm2: number, ppm: number): number {
  return Math.max(4, Math.round(10 + safe(cdMaPerCm2) * 90 + safe(ppm) * 0.25))
}
