import { create } from 'zustand'
import type {
  Additive,
  AdditiveMethod,
  AdditiveTiming,
  Batch,
  BatchResult,
  ElectrodeConfig,
  Mode,
  Pipette,
  PowerConfig,
  Reagent,
  Stock,
  WaterConfig,
} from '../core/model'
import { METALS, defaultEta } from '../core/metals'
import { createStorage } from '../storage'
import { seedReagents } from '../storage/seed'

const storage = createStorage()

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** 表示用バッチ番号 例: 2026-0801-03（同日のバッチ数 + 1） */
export function batchLabel(existing: Batch[], now = new Date()): string {
  const y = now.getFullYear()
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const prefix = `${y}-${md}`
  const sameDay = existing.filter((b) => b.label.startsWith(prefix)).length
  return `${prefix}-${String(sameDay + 1).padStart(2, '0')}`
}

export interface AdditiveDraft {
  /** 'none' = 無添加, 'custom' = 登録フォームを開く, その他 = Reagent.id */
  reagentId: string
  method: AdditiveMethod
  directMg: number
  stockGram: number
  stockPurityPct: number
  stockVolumeMl: number
  /** 母液ライブラリから読み込んだときの濃度上書き（調合欄の編集で解除） */
  stockMolarityOverride: number | null
  activeStockId: string | null
  drops: number
  calibMlPer20: number
  reducerName: string
  reducerMg: number
  capName: string
  timing: AdditiveTiming
}

export interface AppState {
  ready: boolean
  mode: Mode
  label: string
  water: WaterConfig
  electrode: ElectrodeConfig
  power: PowerConfig
  additive: AdditiveDraft
  targetPpm: number

  reagents: Reagent[]
  batches: Batch[]
  stocks: Stock[]
  pipette: Pipette

  init(): Promise<void>
  setMode(mode: Mode): void
  setWater(patch: Partial<WaterConfig>): void
  setElectrode(patch: Partial<ElectrodeConfig>): void
  setPower(patch: Partial<PowerConfig>): void
  setAdditive(patch: Partial<AdditiveDraft>): void
  setTargetPpm(ppm: number): void
  setPipetteCalibration(mlPer20Drops: number): void

  newBatch(): void
  saveBatch(computed: Batch['computed'], additives: Additive[]): Promise<Batch>
  updateResult(id: string, result: BatchResult): Promise<void>
  deleteBatch(id: string): Promise<void>

  addReagent(reagent: Omit<Reagent, 'id'>): Promise<Reagent>
  saveStock(molarity: number, volumeMl: number, reagentId: string): Promise<Stock>
  useStock(stock: Stock): void
  consumeStock(stockId: string, doseMl: number): Promise<void>
}

const initialWater: WaterConfig = { volumeMl: 1000, type: '蒸留水', initialTds: 1, tempC: 24 }

const initialElectrode: ElectrodeConfig = {
  anode: 'Ag',
  cathode: '銀 Ag',
  purity: '99.99%',
  areaCm2: 12,
  gapMm: 35,
  route: 'electrolysis',
}

const initialPower: PowerConfig = {
  mode: 'CC',
  currentMa: 1.0,
  voltageV: 24,
  durationSec: 3 * 3600,
  eta: defaultEta(METALS.Ag),
  reversalMin: 15,
}

const initialAdditive: AdditiveDraft = {
  reagentId: 'seed-na2co3',
  method: 'stock',
  directMg: 27,
  stockGram: 10.6,
  stockPurityPct: 100,
  stockVolumeMl: 100,
  stockMolarityOverride: null,
  activeStockId: null,
  drops: 5,
  calibMlPer20: 1.0,
  reducerName: 'クエン酸三ナトリウム',
  reducerMg: 38,
  capName: 'なし',
  timing: '通電前',
}

const defaultPipette: Pipette = { id: 'default-pipette', name: '標準スポイト', mlPer20Drops: 1.0 }

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  mode: 'colloid',
  label: batchLabel([]),
  water: initialWater,
  electrode: initialElectrode,
  power: initialPower,
  additive: initialAdditive,
  targetPpm: 20,

  reagents: seedReagents(),
  batches: [],
  stocks: [],
  pipette: defaultPipette,

  async init() {
    let reagents = await storage.listReagents()
    if (reagents.length === 0) {
      reagents = seedReagents()
      await Promise.all(reagents.map((r) => storage.saveReagent(r)))
    }
    const [batches, stocks, pipettes] = await Promise.all([
      storage.listBatches(),
      storage.listStocks(),
      storage.listPipettes(),
    ])
    const pipette = pipettes[0] ?? defaultPipette
    set({
      ready: true,
      reagents,
      batches,
      stocks,
      pipette,
      label: batchLabel(batches),
      additive: { ...get().additive, calibMlPer20: pipette.mlPer20Drops },
    })
  },

  setMode: (mode) => set({ mode }),
  setWater: (patch) => set((s) => ({ water: { ...s.water, ...patch } })),
  setElectrode: (patch) =>
    set((s) => {
      const electrode = { ...s.electrode, ...patch }
      const power =
        patch.anode && patch.anode !== s.electrode.anode
          ? // 金属を替えたら効率の初期値もその金属の実測レンジ中央に合わせる
            { ...s.power, eta: defaultEta(METALS[patch.anode]) }
          : s.power
      const routePatch =
        patch.anode && patch.anode !== s.electrode.anode
          ? { route: METALS[patch.anode].recommendedRoute }
          : {}
      return { electrode: { ...electrode, ...routePatch }, power }
    }),
  setPower: (patch) => set((s) => ({ power: { ...s.power, ...patch } })),
  setAdditive: (patch) =>
    set((s) => {
      // 調合欄（g / 純度 / mL）を編集したらライブラリ読込の上書きを解除する
      const editsRecipe =
        patch.stockGram !== undefined ||
        patch.stockPurityPct !== undefined ||
        patch.stockVolumeMl !== undefined ||
        (patch.reagentId !== undefined && patch.reagentId !== s.additive.reagentId)
      return {
        additive: {
          ...s.additive,
          ...(editsRecipe ? { stockMolarityOverride: null, activeStockId: null } : {}),
          ...patch,
        },
      }
    }),
  setTargetPpm: (targetPpm) => set({ targetPpm }),

  setPipetteCalibration(mlPer20Drops) {
    const pipette = { ...get().pipette, mlPer20Drops }
    set((s) => ({ pipette, additive: { ...s.additive, calibMlPer20: mlPer20Drops } }))
    void storage.savePipette(pipette)
  },

  newBatch() {
    set((s) => ({
      label: batchLabel(s.batches),
      water: initialWater,
      electrode: initialElectrode,
      power: initialPower,
      additive: { ...initialAdditive, calibMlPer20: get().pipette.mlPer20Drops },
      targetPpm: 20,
    }))
  },

  async saveBatch(computed, additives) {
    const s = get()
    const batch: Batch = {
      id: newId(),
      label: s.label,
      createdAt: new Date().toISOString(),
      mode: s.mode,
      water: { ...s.water },
      electrode: { ...s.electrode },
      additives,
      power: { ...s.power },
      computed, // 保存時点の値を固定（後日のロジック修正で過去記録が変わらないように）
    }
    await storage.saveBatch(batch)
    const batches = [batch, ...s.batches]
    set({ batches, label: batchLabel(batches) })
    return batch
  },

  async updateResult(id, result) {
    const batch = get().batches.find((b) => b.id === id)
    if (!batch) return
    const updated = { ...batch, result: { ...batch.result, ...result } }
    await storage.saveBatch(updated)
    set((s) => ({ batches: s.batches.map((b) => (b.id === id ? updated : b)) }))
  },

  async deleteBatch(id) {
    await storage.deleteBatch(id)
    set((s) => ({ batches: s.batches.filter((b) => b.id !== id) }))
  },

  async addReagent(reagent) {
    const full: Reagent = { ...reagent, id: newId() }
    await storage.saveReagent(full)
    set((s) => ({ reagents: [...s.reagents, full] }))
    return full
  },

  async saveStock(molarity, volumeMl, reagentId) {
    const stock: Stock = {
      id: newId(),
      reagentId,
      molarity,
      preparedAt: new Date().toISOString(),
      volumeRemainingMl: volumeMl,
    }
    await storage.saveStock(stock)
    set((s) => ({ stocks: [stock, ...s.stocks] }))
    return stock
  },

  useStock(stock) {
    set((s) => ({
      additive: {
        ...s.additive,
        reagentId: stock.reagentId,
        method: 'stock',
        stockMolarityOverride: stock.molarity,
        activeStockId: stock.id,
      },
    }))
  },

  async consumeStock(stockId, doseMl) {
    const stock = get().stocks.find((st) => st.id === stockId)
    if (!stock) return
    const updated = {
      ...stock,
      volumeRemainingMl: Math.max(0, stock.volumeRemainingMl - doseMl),
    }
    await storage.saveStock(updated)
    set((s) => ({ stocks: s.stocks.map((st) => (st.id === stockId ? updated : st)) }))
  },
}))
