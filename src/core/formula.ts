import { ATOMIC_WEIGHTS } from './elements'

/** 化学式が解釈できないときに投げる。message は UI にそのまま表示する。 */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormulaError'
  }
}

/** 水和物のドット記法として受け付ける区切り文字 */
const HYDRATE_SEPARATOR = /[·*.•・]/

/**
 * 化学式から分子量を計算する。
 * 対応: 元素記号+添字 (Na2CO3) / 括弧のネスト (KAl(SO4)2, [Cu(NH3)4]SO4)
 *       / 水和物ドット記法 (Na2CO3·10H2O) / セグメント先頭の係数 (2H2O)
 * 不正な式は FormulaError を投げる。
 */
export function molecularWeight(formula: string): number {
  const stripped = formula.replace(/\s/g, '')
  if (!stripped) throw new FormulaError('化学式を入力してください')

  let total = 0
  for (let part of stripped.split(HYDRATE_SEPARATOR)) {
    if (!part) throw new FormulaError('「·」の前後に式がありません')
    let multiplier = 1
    const m = part.match(/^(\d+)(.*)$/)
    if (m) {
      multiplier = parseInt(m[1]!, 10)
      part = m[2]!
      if (!part) throw new FormulaError('係数のあとに式がありません')
    }
    total += multiplier * segmentWeight(part)
  }
  if (!(total > 0)) throw new FormulaError('分子量が計算できません')
  return total
}

/** 水和物セグメント 1 つ分（ドットで区切られた部分）の式量 */
function segmentWeight(segment: string): number {
  let i = 0

  const readCount = (): number => {
    let digits = ''
    while (i < segment.length && /[0-9]/.test(segment[i]!)) {
      digits += segment[i]
      i++
    }
    return digits ? parseInt(digits, 10) : 1
  }

  const group = (closer: ')' | ']' | null): number => {
    let sum = 0
    while (i < segment.length) {
      const ch = segment[i]!
      if (ch === '(' || ch === '[') {
        const expected = ch === '(' ? ')' : ']'
        i++
        const inner = group(expected)
        i++ // 閉じ括弧を消費（group は閉じ括弧を残して返る）
        sum += inner * readCount()
      } else if (ch === ')' || ch === ']') {
        if (closer !== ch) throw new FormulaError(`対応しない閉じ括弧「${ch}」があります`)
        return sum
      } else if (/[A-Z]/.test(ch)) {
        let el = ch
        i++
        while (i < segment.length && /[a-z]/.test(segment[i]!)) {
          el += segment[i]
          i++
        }
        const weight = ATOMIC_WEIGHTS[el]
        if (weight === undefined) throw new FormulaError(`未知の元素記号「${el}」`)
        sum += weight * readCount()
      } else {
        throw new FormulaError(`解釈できない文字「${ch}」があります`)
      }
    }
    if (closer !== null) throw new FormulaError('括弧が閉じていません')
    return sum
  }

  return group(null)
}

/** 水和物（結晶水つき）の式かどうか。登録フォームの警告表示に使う。 */
export function isHydrate(formula: string): boolean {
  const parts = formula.replace(/\s/g, '').split(HYDRATE_SEPARATOR)
  return parts.length > 1 && parts.slice(1).some((p) => /H2O$/i.test(p))
}
