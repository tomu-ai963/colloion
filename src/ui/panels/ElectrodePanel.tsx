import { METALS, METAL_SYMBOLS, electrochemicalEquivalent, type MetalSymbol, type Route } from '../../core/metals'
import type { Derived } from '../../store/derive'
import { useAppStore } from '../../store/appStore'
import { Advisory } from '../components/Advisory'
import { Field } from '../components/Field'
import { NumberField } from '../components/NumberField'
import { Segmented } from '../components/Segmented'
import c from '../components/controls.module.css'

const ROUTE_LABELS: Record<Route, string> = {
  electrolysis: '電解',
  acid: '酸溶解',
  salt: '塩を溶かす',
}

function anodeOptionLabel(symbol: MetalSymbol): string {
  const m = METALS[symbol]
  const eq = electrochemicalEquivalent(m)
  if (eq > 0) return `${m.nameJa} ${m.ionLabel === '—' ? m.symbol : m.ionLabel} — ${eq.toFixed(3)} mg/C`
  return `${m.nameJa} ${m.symbol} — ${m.symbol === 'Pt' ? '不溶性' : '電解不可'}`
}

export function ElectrodePanel({ derived }: { derived: Derived }) {
  const electrode = useAppStore((s) => s.electrode)
  const setElectrode = useAppStore((s) => s.setElectrode)
  const metal = derived.metal
  const warn = !metal.faradayValid && metal.symbol !== 'Pt'

  return (
    <>
      <div className={c.grid}>
        <Field label="陽極" jp="＋ / 溶出側" htmlFor="anode">
          <select
            id="anode"
            className={c.select}
            value={electrode.anode}
            onChange={(e) => setElectrode({ anode: e.target.value as MetalSymbol })}
          >
            {METAL_SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {anodeOptionLabel(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="陰極" jp="− / 析出側" htmlFor="cathode">
          <select
            id="cathode"
            className={c.select}
            value={electrode.cathode}
            onChange={(e) => setElectrode({ cathode: e.target.value })}
          >
            {['銀 Ag', '白金 Pt', 'グラファイト C', 'ステンレス SUS316'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="純度">
          <Segmented
            options={['99.9%', '99.99%', '99.999%'] as const}
            value={electrode.purity}
            onChange={(purity) => setElectrode({ purity })}
            aria-label="電極の純度"
          />
        </Field>
        <Field label="浸漬面積" htmlFor="area">
          <NumberField
            id="area"
            value={electrode.areaCm2}
            min={0.5}
            step={0.5}
            unit="cm²"
            onChange={(areaCm2) => setElectrode({ areaCm2 })}
          />
        </Field>
        <Field label="電極間距離" htmlFor="gap">
          <NumberField
            id="gap"
            value={electrode.gapMm}
            min={1}
            step={1}
            unit="mm"
            onChange={(gapMm) => setElectrode({ gapMm })}
          />
        </Field>
        <Field label="製法">
          <Segmented<Route>
            options={['electrolysis', 'acid', 'salt'] as const}
            value={electrode.route}
            onChange={(route) => setElectrode({ route })}
            labels={ROUTE_LABELS}
            aria-label="製法"
          />
          {electrode.route !== metal.recommendedRoute && (
            <div className={c.invalidMsg} style={{ color: 'var(--ink2)' }}>
              この金属の推奨は「{ROUTE_LABELS[metal.recommendedRoute]}」です
            </div>
          )}
        </Field>
      </div>

      <Advisory warn={warn} html={metal.advisory} />

      <div className={c.note}>
        電流密度は <b>{derived.cd.toFixed(2)}</b> mA/cm²。
        低いほど粒子が細かく、色が澄む傾向があります。0.1
        を超えたあたりから黒い脱落片が出やすくなります。
      </div>
    </>
  )
}
