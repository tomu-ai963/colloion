import type { WaterType } from '../../core/model'
import { useAppStore } from '../../store/appStore'
import { Chips } from '../components/Chips'
import { Field } from '../components/Field'
import { NumberField } from '../components/NumberField'
import { Segmented } from '../components/Segmented'
import c from '../components/controls.module.css'

const WATER_TYPES = ['蒸留水', 'RO水', '精製水', '超純水'] as const

export function WaterPanel() {
  const water = useAppStore((s) => s.water)
  const setWater = useAppStore((s) => s.setWater)

  return (
    <>
      <div className={c.grid}>
        <Field label="水量" jp="/ Volume" htmlFor="vol">
          <NumberField
            id="vol"
            value={water.volumeMl}
            min={10}
            step={10}
            unit="mL"
            onChange={(volumeMl) => setWater({ volumeMl })}
          />
          <Chips values={[250, 500, 1000, 2000]} onPick={(volumeMl) => setWater({ volumeMl })} />
        </Field>
        <Field label="水の種類">
          <Segmented<WaterType>
            options={WATER_TYPES}
            value={water.type}
            onChange={(type) => setWater({ type })}
            aria-label="水の種類"
          />
        </Field>
        <Field label="初期 TDS" htmlFor="tds0">
          <NumberField
            id="tds0"
            value={water.initialTds}
            min={0}
            step={1}
            unit="ppm"
            onChange={(initialTds) => setWater({ initialTds })}
          />
        </Field>
        <Field label="水温" jp="/ Temp" htmlFor="temp">
          <input
            type="range"
            className={c.range}
            id="temp"
            min={5}
            max={95}
            value={water.tempC}
            onChange={(e) => setWater({ tempC: Number(e.target.value) })}
          />
          <div className={c.rangeVal}>{water.tempC} °C</div>
        </Field>
      </div>
      <div className={c.note}>
        水温が高いほど導電率が上がり、同じ電圧でも電流が増えます。
        <b>定電流（CC）で回すなら影響は小さめ</b>ですが、粒径には効いてきます。
      </div>
    </>
  )
}
