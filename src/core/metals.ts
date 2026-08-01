/** ファラデー定数 [C/mol] */
export const FARADAY = 96485

export type Route = 'electrolysis' | 'acid' | 'salt'

export type MetalSymbol = 'Ag' | 'Au' | 'Cu' | 'Zn' | 'Mg' | 'Fe' | 'Mn' | 'Ca' | 'Pt'

export interface Metal {
  symbol: MetalSymbol
  nameJa: string
  atomicWeight: number
  /** 溶出時の価数 n */
  valence: number
  ionLabel: string
  /** 水酸化物が析出し始める目安 pH */
  hydroxidePh: number
  /** 実測される電流効率のレンジ [%]。Mg は負差効果で 100% を超える */
  etaRange: [number, number]
  /** ビーカー表示色 'r,g,b' */
  colloidRgb: string
  /** ファラデーの法則で溶出量を予測できるか（Mg は自己腐食のため不成立） */
  faradayValid: boolean
  /** 陽極として電解溶出が可能か（Ca は水と反応、Pt は不溶） */
  electrolyzable: boolean
  /** UI に出す注意文（HTML 可） */
  advisory: string
  recommendedRoute: Route
}

export const METALS: Readonly<Record<MetalSymbol, Metal>> = {
  Ag: {
    symbol: 'Ag',
    nameJa: '銀',
    atomicWeight: 107.868,
    valence: 1,
    ionLabel: 'Ag⁺',
    hydroxidePh: 9.5,
    etaRange: [88, 96],
    colloidRgb: '200,154,60',
    faradayValid: true,
    electrolyzable: true,
    advisory:
      '素直に溶けます。塩化物イオンが入ると AgCl で白濁するので、水道水は避けてください。',
    recommendedRoute: 'electrolysis',
  },
  Au: {
    symbol: 'Au',
    nameJa: '金',
    atomicWeight: 196.967,
    valence: 3,
    ionLabel: 'Au³⁺',
    hydroxidePh: 3.0,
    etaRange: [70, 90],
    colloidRgb: '163,40,70',
    faradayValid: true,
    electrolyzable: true,
    advisory: '電解での溶出は起きにくく、通常は塩化金酸から還元してつくります。',
    recommendedRoute: 'salt',
  },
  Cu: {
    symbol: 'Cu',
    nameJa: '銅',
    atomicWeight: 63.546,
    valence: 2,
    ionLabel: 'Cu²⁺',
    hydroxidePh: 5.5,
    etaRange: [92, 99],
    colloidRgb: '150,70,45',
    faradayValid: true,
    electrolyzable: true,
    advisory:
      'pH 5.5 あたりから水酸化銅が出て青白く濁ります。クエン酸で錯体にすると窓が広がります。',
    recommendedRoute: 'electrolysis',
  },
  Zn: {
    symbol: 'Zn',
    nameJa: '亜鉛',
    atomicWeight: 65.38,
    valence: 2,
    ionLabel: 'Zn²⁺',
    hydroxidePh: 7.0,
    etaRange: [85, 98],
    colloidRgb: '140,145,150',
    faradayValid: true,
    electrolyzable: true,
    advisory:
      '電解でよく溶けます。ただし <b>pH 7 を超えると水酸化亜鉛で白濁</b>します。陰極から水素が出て液全体の pH が上がっていくので、長時間まわすなら pH の実測を挟んでください。両性なので pH 11 以上で再溶解します。',
    recommendedRoute: 'electrolysis',
  },
  Mg: {
    symbol: 'Mg',
    nameJa: 'マグネシウム',
    atomicWeight: 24.305,
    valence: 2,
    ionLabel: 'Mg²⁺',
    hydroxidePh: 9.5,
    etaRange: [130, 200],
    colloidRgb: '150,152,155',
    faradayValid: false,
    electrolyzable: true,
    advisory:
      '<b>ファラデーの法則が成立しません。</b>Mg は水と直接反応して自己腐食するため（負差効果）、実効効率が 130〜200% と 100% を超えます。理論値は下限としてしか使えません。加えて Mg(OH)₂ の溶解度が極めて低く、電解では白い濁りになりがちです。<b>酸溶解に切り替えることをおすすめします</b>。',
    recommendedRoute: 'acid',
  },
  Fe: {
    symbol: 'Fe',
    nameJa: '鉄',
    atomicWeight: 55.845,
    valence: 2,
    ionLabel: 'Fe²⁺',
    hydroxidePh: 7.5,
    etaRange: [90, 99],
    colloidRgb: '120,85,55',
    faradayValid: true,
    electrolyzable: true,
    advisory:
      '溶けますが Fe²⁺ は空気中で速やかに Fe³⁺ に酸化し、赤褐色の水酸化鉄が沈みます。密閉と脱気が要ります。',
    recommendedRoute: 'electrolysis',
  },
  Mn: {
    symbol: 'Mn',
    nameJa: 'マンガン',
    atomicWeight: 54.938,
    valence: 2,
    ionLabel: 'Mn²⁺',
    hydroxidePh: 8.8,
    etaRange: [88, 97],
    colloidRgb: '150,140,120',
    faradayValid: true,
    electrolyzable: true,
    advisory:
      '比較的安定です。酸化されると褐色の二酸化マンガンになるので、こちらも空気との接触を減らしてください。',
    recommendedRoute: 'electrolysis',
  },
  Ca: {
    symbol: 'Ca',
    nameJa: 'カルシウム',
    atomicWeight: 40.078,
    valence: 2,
    ionLabel: 'Ca²⁺',
    hydroxidePh: 12.5,
    etaRange: [0, 0],
    colloidRgb: '190,190,185',
    faradayValid: false,
    electrolyzable: false,
    advisory:
      '<b>金属カルシウムは水と激烈に反応するため電解できません。</b>炭酸カルシウム（卵殻・貝殻など）をクエン酸や酢酸に溶かす経路が現実的です。',
    recommendedRoute: 'acid',
  },
  Pt: {
    symbol: 'Pt',
    nameJa: '白金',
    atomicWeight: 195.084,
    valence: 2,
    ionLabel: '—',
    hydroxidePh: 14,
    etaRange: [0, 0],
    colloidRgb: '70,72,75',
    faradayValid: false,
    electrolyzable: false,
    advisory: '不溶性電極です。陰極側や、陽極を溶かしたくない場合の対極に使います。',
    recommendedRoute: 'electrolysis',
  },
}

export const METAL_SYMBOLS = Object.keys(METALS) as MetalSymbol[]

/**
 * 電気化学当量 [mg/C] = M / (n × F) × 1000。
 * マスタに数値をハードコードせず、原子量と価数から導出する。
 * 電解不可（Ca）・不溶性（Pt）は 0 を返す。
 */
export function electrochemicalEquivalent(metal: Metal): number {
  if (!metal.electrolyzable || metal.valence <= 0) return 0
  return (metal.atomicWeight / (metal.valence * FARADAY)) * 1000
}

/** UI の効率スライダー初期値: 実測レンジの中央（レンジなしは 100%） */
export function defaultEta(metal: Metal): number {
  const [lo, hi] = metal.etaRange
  if (hi <= 0) return 100
  return Math.round((lo + hi) / 2)
}
