/**
 * 母液（ストック溶液）と滴下の計算。
 * 母液は濃度 [mol/L] で保持する — 仕込み水量が変わっても
 * 目標 mmol/L を保つ滴数を逆算できるようにするため。
 */

const safe = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/**
 * 母液のモル濃度 [mol/L]。
 * 秤量 gram [g] に含量 purityPct [%] を掛けた実質量を分子量 mw で割り、
 * 溶媒量 volumeMl [mL] で割る。
 */
export function stockMolarity(
  gram: number,
  purityPct: number,
  mw: number,
  volumeMl: number,
): number {
  const g = safe(gram) * (safe(purityPct) / 100)
  const vL = safe(volumeMl) / 1000
  if (safe(mw) <= 0 || vL <= 0) return 0
  return g / mw / vL
}

/**
 * 1 滴の体積 [mL]。スポイト依存（0.03〜0.06 mL）なので
 * 「20 滴の実測体積」からキャリブレーションする。
 * この値は試薬ではなく器具（Pipette）に紐づけて保存する。
 */
export function dropVolume(mlPer20Drops: number): number {
  return safe(mlPer20Drops) / 20
}

export interface FinalConcentration {
  mmolPerL: number
  mg: number
  ppm: number
}

/**
 * 母液 doseMl [mL] を仕込み水 batchVolumeMl [mL] に分注したときの最終濃度。
 * mg / ppm の換算に分子量 mw が要る。
 */
export function finalConcentration(
  molarity: number,
  mw: number,
  doseMl: number,
  batchVolumeMl: number,
): FinalConcentration {
  const mmol = safe(molarity) * safe(doseMl) // mol/L × mL = mmol
  const vL = safe(batchVolumeMl) / 1000
  const mg = mmol * safe(mw)
  return {
    mmolPerL: vL > 0 ? mmol / vL : 0,
    mg,
    ppm: vL > 0 ? mg / vL : 0,
  }
}

/**
 * 目標 targetMmolL [mmol/L] を仕込み水 batchVolumeMl で実現するのに必要な滴数。
 * 母液が未調製（濃度 0）などで算出不能のときは null。
 */
export function requiredDrops(
  targetMmolL: number,
  molarity: number,
  dropVol: number,
  batchVolumeMl: number,
): number | null {
  const perDropMmol = safe(molarity) * safe(dropVol) // mmol/滴
  if (perDropMmol <= 0) return null
  const neededMmol = safe(targetMmolL) * (safe(batchVolumeMl) / 1000)
  return neededMmol / perDropMmol
}
