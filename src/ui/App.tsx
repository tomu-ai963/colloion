import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Additive } from '../core/model'
import { REDUCERS, derive } from '../store/derive'
import { useAppStore } from '../store/appStore'
import { useRunStore } from '../store/runStore'
import { useAuthStore } from '../auth/store'
import s from './App.module.css'
import { RecoveryDialog } from './run/RecoveryDialog'
import { RunScreen } from './run/RunScreen'
import { SyncBadge } from './sync/SyncBadge'
import { AdditivePanel } from './panels/AdditivePanel'
import { ElectrodePanel } from './panels/ElectrodePanel'
import { LogPanel } from './panels/LogPanel'
import { PowerPanel } from './panels/PowerPanel'
import { WaterPanel } from './panels/WaterPanel'
import { Readout } from './readout/Readout'

type TabId = 'water' | 'elec' | 'add' | 'power' | 'log'

const TABS: { id: TabId; num: string; label: string; title: string; sub: string }[] = [
  { id: 'water', num: '01', label: '水', title: '水', sub: '仕込み量と水質。ここで入れた量が ppm の分母になります。' },
  { id: 'elec', num: '02', label: '電極', title: '電極', sub: '陽極の金属が溶け出します。ここの選択で電気化学当量が切り替わります。' },
  { id: 'add', num: '03', label: '添加物', title: '添加物', sub: '電解質・還元剤・保護剤。金コロイドでは還元剤とのモル比が粒径を決めます。' },
  { id: 'power', num: '04', label: '通電', title: '通電', sub: '直流安定化電源の設定と積算時間。ここが ppm の分子になります。' },
  { id: 'log', num: '05', label: '記録', title: '記録', sub: '過去のバッチ。実測を入れるたびに η の補正案が更新されます。' },
]

export function App() {
  const store = useAppStore()
  const [tab, setTab] = useState<TabId>('water')
  const railRef = useRef<HTMLElement>(null)

  const runActive = useRunStore((st) => st.session !== null && st.batch !== null)
  const hasRecovery = useRunStore((st) => st.recovery !== null)

  useEffect(() => {
    void useAppStore
      .getState()
      .init()
      .then(() => useRunStore.getState().checkRecovery())
      // 同期サーバーがあればセッションを確認し、ログイン済みなら同期を始める
      .then(() => useAuthStore.getState().init())
  }, [])

  const derived = useMemo(
    () =>
      derive({
        mode: store.mode,
        water: store.water,
        electrode: store.electrode,
        power: store.power,
        additive: store.additive,
        targetPpm: store.targetPpm,
        reagents: store.reagents,
      }),
    [store.mode, store.water, store.electrode, store.power, store.additive, store.targetPpm, store.reagents],
  )

  const buildAdditives = (): Additive[] => {
    const a = store.additive
    const list: Additive[] = []
    if (derived.reagent) {
      const base = {
        reagentId: derived.reagent.id,
        name: derived.reagent.name,
        mw: derived.reagent.mw,
        role: derived.reagent.role,
        timing: a.timing,
      }
      list.push(
        a.method === 'direct'
          ? { ...base, method: 'direct', massMg: a.directMg }
          : {
              ...base,
              method: 'stock',
              stockId: a.activeStockId ?? undefined,
              drops: a.drops,
              doseMl: derived.doseMl,
              finalMmolPerL: derived.finalMmolPerL,
            },
      )
    }
    if (a.reducerName !== 'なし（電解のみ）') {
      list.push({
        reagentId: null,
        name: a.reducerName,
        mw: REDUCERS[a.reducerName]?.mw ?? 0,
        role: '還元剤',
        method: 'direct',
        massMg: a.reducerMg,
        timing: a.timing,
      })
    }
    if (a.capName !== 'なし') {
      list.push({
        reagentId: null,
        name: a.capName,
        mw: 0,
        role: '保護剤 / 分散剤',
        method: 'direct',
        timing: a.timing,
      })
    }
    return list
  }

  const persistBatch = async () => {
    const batch = await store.saveBatch(
      {
        mg: derived.mg,
        ppm: derived.ppm,
        coulombs: derived.coulombs,
        currentDensity: derived.cd,
      },
      buildAdditives(),
    )
    if (store.additive.method === 'stock' && store.additive.activeStockId) {
      await store.consumeStock(store.additive.activeStockId, derived.doseMl, batch.id)
    }
    return batch
  }

  const save = async () => {
    await persistBatch()
    setTab('log')
  }

  // 通電を開始: 現在の条件をバッチとして保存し、そのバッチでセッションを開く
  const startRun = async () => {
    const batch = await persistBatch()
    await useRunStore.getState().start(batch)
  }

  // 矢印キーでレールを移動できるように（tablist のキーボード操作）
  const onRailKeyDown = (e: ReactKeyboardEvent) => {
    const idx = TABS.findIndex((t) => t.id === tab)
    let next: number | null = null
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % TABS.length
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length
    if (next !== null) {
      e.preventDefault()
      const target = TABS[next]!
      setTab(target.id)
      railRef.current
        ?.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"]`)
        ?.focus()
    }
  }

  const active = TABS.find((t) => t.id === tab)!

  return (
    <>
      <header className={s.topbar}>
        <div>
          <div className={s.brand}>
            COLLO<em>I</em>ON
          </div>
          <div className={s.brandSub}>コロイド電解ノート</div>
        </div>
        <div className={s.modeSw} role="group" aria-label="モード">
          <button
            type="button"
            aria-pressed={store.mode === 'colloid'}
            onClick={() => store.setMode('colloid')}
          >
            コロイド
          </button>
          <button type="button" aria-pressed={store.mode === 'ion'} onClick={() => store.setMode('ion')}>
            イオン
          </button>
        </div>
        <div className={s.batchId}>BATCH&nbsp;&nbsp;{store.label}</div>
        <SyncBadge />
        <button type="button" className={s.btnSolid} onClick={() => void startRun()}>
          通電を開始
        </button>
        <button type="button" className={s.btnGhost} onClick={() => void save()}>
          バッチを保存
        </button>
        <button type="button" className={s.btnGhost} onClick={() => store.newBatch()}>
          新しいバッチ
        </button>
      </header>

      <div className={s.shell}>
        <nav className={s.rail} role="tablist" aria-label="工程" ref={railRef} onKeyDown={onRailKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={s.railItem}
              onClick={() => setTab(t.id)}
            >
              <span className={s.num}>{t.num}</span>
              {t.label}
            </button>
          ))}
        </nav>

        <main className={s.stage}>
          <section
            className={s.panel}
            id={`panel-${active.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${active.id}`}
          >
            <div className={s.panelHead}>
              <h2>{active.title}</h2>
              <p>{active.sub}</p>
            </div>
            {tab === 'water' && <WaterPanel />}
            {tab === 'elec' && <ElectrodePanel derived={derived} />}
            {tab === 'add' && <AdditivePanel derived={derived} />}
            {tab === 'power' && <PowerPanel derived={derived} />}
            {tab === 'log' && <LogPanel />}
          </section>
        </main>

        <Readout mode={store.mode} derived={derived} eta={store.power.eta} volumeMl={store.water.volumeMl} />
      </div>

      {hasRecovery && <RecoveryDialog />}
      {runActive && <RunScreen onExit={() => setTab('log')} />}
    </>
  )
}
