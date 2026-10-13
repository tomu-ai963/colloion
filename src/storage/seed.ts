import { molecularWeight } from '../core/formula'
import type { Reagent } from '../core/model'

/**
 * 初期シード試薬。あくまで初期値で、ユーザー登録（化学式から）がメイン。
 * mw はハードコードせずパーサーから導出する。
 * ID 固定・updatedAt = 0 なので、各端末で作られても同期で同じレコードとして扱われ、
 * どの実データにも負ける。
 */
export function seedReagents(): Reagent[] {
  const def = (
    id: string,
    name: string,
    formula: string,
    role: Reagent['role'],
    purityPct = 100,
  ): Reagent => ({
    id,
    name,
    formula,
    mw: molecularWeight(formula),
    role,
    purityPct,
    updatedAt: 0,
  })

  return [
    def('seed-na2co3', '炭酸ナトリウム', 'Na2CO3', '電解質'),
    def('seed-nahco3', '炭酸水素ナトリウム', 'NaHCO3', '電解質'),
    def('seed-kno3', '硝酸カリウム', 'KNO3', '電解質'),
    def('seed-citrate', 'クエン酸三ナトリウム 二水和物', 'C6H5Na3O7·2H2O', '還元剤'),
    def('seed-nacl', '塩化ナトリウム', 'NaCl', '電解質'),
  ]
}
