import { formatDuration, secondsToHM } from '../../core/units'
import type { Derived } from '../../store/derive'
import { useAppStore } from '../../store/appStore'
import { Chips } from '../components/Chips'
import { Field } from '../components/Field'
import { NumberField } from '../components/NumberField'
import { Segmented } from '../components/Segmented'
import c from '../components/controls.module.css'

export function PowerPanel({ derived }: { derived: Derived }) {
  const power = useAppStore((s) => s.power)
  const setPower = useAppStore((s) => s.setPower)
  const water = useAppStore((s) => s.water)
  const targetPpm = useAppStore((s) => s.targetPpm)
  const setTargetPpm = useAppStore((s) => s.setTargetPpm)

  const { hours, minutes } = secondsToHM(power.durationSec)
  const setHm = (h: number, m: number) => setPower({ durationSec: h * 3600 + m * 60 })

  return (
    <>
      <div className={c.grid}>
        <Field label="モード">
          <Segmented
            options={['CC', 'CV'] as const}
            value={power.mode}
            onChange={(mode) => setPower({ mode })}
            labels={{ CC: 'CC 定電流', CV: 'CV 定電圧' }}
            aria-label="電源モード"
          />
        </Field>
        <Field label="電流" htmlFor="cur">
          <NumberField
            id="cur"
            value={power.currentMa}
            min={0.05}
            step={0.05}
            unit="mA"
            onChange={(currentMa) => setPower({ currentMa })}
          />
          <Chips
            values={[0.5, 1, 3, 10]}
            format={(v) => v.toFixed(1)}
            onPick={(currentMa) => setPower({ currentMa })}
          />
        </Field>
        <Field label="電圧（上限）" htmlFor="volt">
          <NumberField
            id="volt"
            value={power.voltageV}
            min={1}
            step={1}
            unit="V"
            onChange={(voltageV) => setPower({ voltageV })}
          />
        </Field>
        <Field label="通電時間">
          <div className={c.unitRow}>
            <NumberField
              aria-label="時間"
              value={hours}
              min={0}
              step={1}
              onChange={(h) => setHm(h, minutes)}
            />
            <span className={c.unit}>時間</span>
            <NumberField
              aria-label="分"
              value={minutes}
              min={0}
              max={59}
              step={5}
              onChange={(m) => setHm(hours, m)}
            />
            <span className={c.unit}>分</span>
          </div>
        </Field>
        <Field label="電流効率 η" htmlFor="eff">
          <input
            type="range"
            className={power.eta > 100 ? `${c.range} ${c.rangeOver}` : c.range}
            id="eff"
            min={40}
            max={200}
            value={power.eta}
            onChange={(e) => setPower({ eta: Number(e.target.value) })}
          />
          <div className={c.rangeVal}>
            {power.eta} %
            {power.eta > 100 && <span className={c.overBadge}>100% 超 — 負差効果域</span>}
            {!derived.metal.faradayValid && derived.metal.symbol === 'Mg' && (
              <span className={c.unit}>　理論値は下限としてのみ有効</span>
            )}
          </div>
        </Field>
        <Field label="極性反転" htmlFor="rev">
          <select
            id="rev"
            className={c.select}
            value={power.reversalMin}
            onChange={(e) => setPower({ reversalMin: Number(e.target.value) })}
          >
            <option value={0}>なし</option>
            <option value={15}>15分ごと</option>
            <option value={30}>30分ごと</option>
            <option value={60}>60分ごと</option>
          </select>
        </Field>
      </div>

      <div className={c.inverse}>
        <h3>逆算</h3>
        <p>目標 ppm から必要な通電時間を出します。電流と水量は現在の設定を使用。</p>
        <div className={c.field} style={{ maxWidth: 220 }}>
          <label className={c.lbl} htmlFor="target">
            目標濃度
          </label>
          <NumberField
            id="target"
            value={targetPpm}
            min={0.5}
            step={0.5}
            unit="ppm"
            onChange={setTargetPpm}
          />
        </div>
        <div className={c.inverseOut}>
          {derived.requiredSec !== null ? formatDuration(derived.requiredSec) : '— 電解不可'}
          <span>
            @ {power.currentMa} mA / {water.volumeMl} mL
          </span>
        </div>
      </div>
    </>
  )
}
