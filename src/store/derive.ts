import {
  computeElectrolysis,
  currentDensity,
  estimatedParticleNm,
  requiredDurationSec,
} from '../core/faraday'
import { molecularWeight } from '../core/formula'
import { METALS, electrochemicalEquivalent, type Metal } from '../core/metals'
import type { Reagent } from '../core/model'
import { dropVolume, finalConcentration, requiredDrops, stockMolarity } from '../core/stock'
import type { AppState } from './appStore'

/**
 * コーンシロップ（Karo ライト）の「ブドウ糖換算の見かけの分子量」[mg/mmol]。
 * 混合物で分子量が定まらないので、還元糖をブドウ糖に換算したモル数で数える:
 *   還元糖 [mmol] = 秤量 [mg] × 固形分 × DE / 100 ÷ 180.16（ブドウ糖）
 * - 固形分 30 / 41: ラベルの炭水化物 30 g（大さじ 2 = 30 mL）÷ その重さ 41 g（栄養データベースの値。
 *   ラベルには重さが無い）
 * - DE 42: 普通のコーンシロップの代表値（Karo は DE を公表していない）。ラベルの糖類 10 g / 炭水化物 30 g
 *   ＝ 単糖・二糖が固形分の約 1/3 という比は、DE 42 のコーンシロップの組成と合う。
 *   原材料はコーンシロップ・塩・バニラで、砂糖（還元しない）や異性化糖は入っていない
 * 製品のロットや保存中の水分で数割はずれうる。目安として使う
 */
export const CORN_SYRUP_KARO_LIGHT = {
  solidsFraction: 30 / 41,
  de: 42,
} as const
export const CORN_SYRUP_MG_PER_MMOL =
  molecularWeight('C6H12O6') / (CORN_SYRUP_KARO_LIGHT.solidsFraction * (CORN_SYRUP_KARO_LIGHT.de / 100))
export const CORN_SYRUP_NAME = 'コーンシロップ（Karo ライト）'

/**
 * 還元剤の分子量（モル比計算用）。式が定まるものはパーサーから導出。
 * コーンシロップは混合物なので式は無く、mw はブドウ糖換算の見かけの値（CORN_SYRUP_MG_PER_MMOL）
 */
export const REDUCERS: Readonly<Record<string, { formula: string | null; mw: number | null }>> = {
  'なし（電解のみ）': { formula: null, mw: null },
  'クエン酸三ナトリウム': { formula: 'C6H5Na3O7·2H2O', mw: molecularWeight('C6H5Na3O7·2H2O') },
  'タンニン酸': { formula: 'C76H52O46', mw: molecularWeight('C76H52O46') },
  'アスコルビン酸': { formula: 'C6H8O6', mw: molecularWeight('C6H8O6') },
  '水素化ホウ素ナトリウム NaBH₄': { formula: 'NaBH4', mw: molecularWeight('NaBH4') },
  [CORN_SYRUP_NAME]: { formula: null, mw: CORN_SYRUP_MG_PER_MMOL },
}

export interface Derived {
  metal: Metal
  equivalentMgPerC: number
  coulombs: number
  mg: number
  ppm: number
  cd: number
  particleNm: number
  /** 目標 ppm までの必要時間 [s]。不溶性電極などは null */
  requiredSec: number | null
  /** 還元剤 / 金属イオンのモル比。算出不能は null */
  molarRatio: number | null

  reagent: Reagent | null
  stockMolarity: number
  dropVolumeMl: number
  doseMl: number
  finalMmolPerL: number
  finalMg: number
  finalPpm: number
  /** 現在の水量で 1.00 mmol/L を保つのに必要な滴数。null = 母液未調製 */
  neededDrops: number | null
}

type DeriveInput = Pick<
  AppState,
  'mode' | 'water' | 'electrode' | 'power' | 'additive' | 'targetPpm' | 'reagents'
>

export function derive(s: DeriveInput): Derived {
  const metal = METALS[s.electrode.anode]
  const eq = electrochemicalEquivalent(metal)

  const { coulombs, mg, ppm } = computeElectrolysis({
    equivalentMgPerC: eq,
    currentMa: s.power.currentMa,
    durationSec: s.power.durationSec,
    etaPct: s.power.eta,
    volumeMl: s.water.volumeMl,
  })
  const cd = currentDensity(s.power.currentMa, s.electrode.areaCm2)

  const requiredSec = requiredDurationSec(s.targetPpm, {
    equivalentMgPerC: eq,
    currentMa: s.power.currentMa,
    etaPct: s.power.eta,
    volumeMl: s.water.volumeMl,
  })

  const reducerMw = REDUCERS[s.additive.reducerName]?.mw ?? null
  const metalMmol = metal.atomicWeight > 0 ? mg / metal.atomicWeight : 0
  const reducerMmol = reducerMw ? s.additive.reducerMg / reducerMw : 0
  const molarRatio = reducerMw && metalMmol > 1e-9 ? reducerMmol / metalMmol : null

  const reagent = s.reagents.find((r) => r.id === s.additive.reagentId) ?? null
  const mw = reagent?.mw ?? 0
  const molarity =
    s.additive.stockMolarityOverride ??
    stockMolarity(s.additive.stockGram, s.additive.stockPurityPct, mw, s.additive.stockVolumeMl)
  const dropV = dropVolume(s.additive.calibMlPer20)

  let doseMl: number
  let final: { mmolPerL: number; mg: number; ppm: number }
  if (s.additive.method === 'direct') {
    doseMl = 0
    const effMg = Math.max(0, s.additive.directMg) * ((reagent?.purityPct ?? 100) / 100)
    const vL = s.water.volumeMl / 1000
    const mmol = mw > 0 ? effMg / mw : 0
    final = {
      mmolPerL: vL > 0 ? mmol / vL : 0,
      mg: effMg,
      ppm: vL > 0 ? effMg / vL : 0,
    }
  } else {
    doseMl = Math.max(0, s.additive.drops) * dropV
    final = finalConcentration(molarity, mw, doseMl, s.water.volumeMl)
  }

  const neededDrops = requiredDrops(1.0, molarity, dropV, s.water.volumeMl)

  return {
    metal,
    equivalentMgPerC: eq,
    coulombs,
    mg,
    ppm,
    cd,
    particleNm: estimatedParticleNm(cd, ppm),
    requiredSec,
    molarRatio,
    reagent,
    stockMolarity: molarity,
    dropVolumeMl: dropV,
    doseMl,
    finalMmolPerL: final.mmolPerL,
    finalMg: final.mg,
    finalPpm: final.ppm,
    neededDrops,
  }
}

/**
 * 実測 TDS からの η 補正案 [%]。
 * 実測がある過去バッチについて（実測 / 理論）比の平均を、そのバッチが使った η に掛ける。
 * TDS はイオン性金属しか見えないため下振れする点は UI 側の注記で補う。
 */
export function suggestEta(
  batches: { computed: { ppm: number }; power: { eta: number }; result?: { measuredTds?: number } }[],
): number | null {
  const samples = batches
    .filter((b) => (b.result?.measuredTds ?? 0) > 0 && b.computed.ppm > 0)
    .map((b) => (b.result!.measuredTds! / b.computed.ppm) * b.power.eta)
  if (samples.length === 0) return null
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return Math.round(Math.min(200, Math.max(40, mean)))
}
