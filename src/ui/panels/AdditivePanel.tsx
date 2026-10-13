import { useMemo, useState } from 'react'
import { FormulaError, isHydrate, molecularWeight } from '../../core/formula'
import type { AdditiveRole, AdditiveTiming } from '../../core/model'
import { stockRemainingMl } from '../../core/stock'
import { REDUCERS, type Derived } from '../../store/derive'
import { useAppStore } from '../../store/appStore'
import { Field } from '../components/Field'
import { NumberField } from '../components/NumberField'
import { Segmented } from '../components/Segmented'
import c from '../components/controls.module.css'

const ROLES: AdditiveRole[] = ['電解質', '還元剤', '保護剤 / 分散剤', 'pH 調整']
const TIMINGS: AdditiveTiming[] = ['通電前', '通電中', '通電後']

/** 化学式の水和物ドットより前（無水部分）だけの分子量。ヒント表示用 */
function anhydrousMw(formula: string): number | null {
  const head = formula.replace(/\s/g, '').split(/[·*.•・]/)[0]
  if (!head) return null
  try {
    return molecularWeight(head)
  } catch {
    return null
  }
}

function ReagentForm({ onDone, onCancel }: { onDone(id: string): void; onCancel(): void }) {
  const addReagent = useAppStore((s) => s.addReagent)
  const [name, setName] = useState('')
  const [formula, setFormula] = useState('Na2CO3·10H2O')
  const [purityPct, setPurityPct] = useState(99.5)
  const [role, setRole] = useState<AdditiveRole>('電解質')

  const parsed = useMemo(() => {
    try {
      return { mw: molecularWeight(formula), error: null }
    } catch (e) {
      return { mw: null, error: e instanceof FormulaError ? e.message : '式を解釈できません' }
    }
  }, [formula])

  const hydrate = parsed.mw !== null && isHydrate(formula)
  const anhydrous = hydrate ? anhydrousMw(formula) : null

  const save = async () => {
    if (parsed.mw === null) return
    const reagent = await addReagent({
      name: name.trim() || '登録した試薬',
      formula: formula.trim(),
      mw: parsed.mw,
      purityPct,
      role,
    })
    onDone(reagent.id)
  }

  return (
    <div className={c.stockCustom}>
      <div className={c.stockStep}>
        <span className={c.st}>試薬を登録</span>
        <div className={c.grid} style={{ gap: '16px 20px' }}>
          <Field label="名称" htmlFor="c-name">
            <input
              type="text"
              className={`${c.input} ${c.inputText}`}
              id="c-name"
              placeholder="炭酸ナトリウム 十水和物"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="化学式" htmlFor="c-formula">
            <input
              type="text"
              className={`${c.input} ${c.inputText}`}
              id="c-formula"
              spellCheck={false}
              value={formula}
              aria-invalid={parsed.error !== null}
              onChange={(e) => setFormula(e.target.value)}
            />
            <div className={parsed.error ? c.fxErr : c.fx} role="status">
              {parsed.error ?? `分子量 ${parsed.mw!.toFixed(2)}`}
            </div>
          </Field>
          <Field label="含量 / 純度" htmlFor="c-purity">
            <NumberField
              id="c-purity"
              value={purityPct}
              min={1}
              max={100}
              step={0.1}
              unit="%"
              onChange={setPurityPct}
            />
          </Field>
          <Field label="用途" htmlFor="c-role">
            <select
              id="c-role"
              className={c.select}
              value={role}
              onChange={(e) => setRole(e.target.value as AdditiveRole)}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        </div>
        {hydrate && (
          <div className={c.calib} role="alert">
            水和物として認識しました。
            {anhydrous !== null && parsed.mw !== null && (
              <>
                無水は {anhydrous.toFixed(2)}、この水和物は {parsed.mw.toFixed(2)} で
                <b> {(parsed.mw / anhydrous).toFixed(1)} 倍ちがいます</b>。
                同じ秤量でもモル数が変わるので、登録した式のまま秤量してください。
              </>
            )}
          </div>
        )}
        <div className={c.row} style={{ marginTop: 16 }}>
          <button type="button" className={c.btnSave} onClick={save} disabled={parsed.mw === null}>
            試薬に追加
          </button>
          <button type="button" className={c.btnCancel} onClick={onCancel}>
            やめる
          </button>
        </div>
      </div>
    </div>
  )
}

export function AdditivePanel({ derived }: { derived: Derived }) {
  const additive = useAppStore((s) => s.additive)
  const setAdditive = useAppStore((s) => s.setAdditive)
  const reagents = useAppStore((s) => s.reagents)
  const stocks = useAppStore((s) => s.stocks)
  const saveStock = useAppStore((s) => s.saveStock)
  const applyStock = useAppStore((s) => s.useStock)
  const setPipetteCalibration = useAppStore((s) => s.setPipetteCalibration)
  const volumeMl = useAppStore((s) => s.water.volumeMl)
  const [showCustom, setShowCustom] = useState(false)

  const selectReagent = (id: string) => {
    if (id === 'custom') {
      setShowCustom(true)
      return
    }
    const reagent = reagents.find((r) => r.id === id)
    setAdditive({ reagentId: id, ...(reagent ? { stockPurityPct: reagent.purityPct } : {}) })
  }

  const reagentName = (id: string) => reagents.find((r) => r.id === id)?.name ?? '不明な試薬'
  const daysSince = (iso: string) =>
    Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))

  return (
    <>
      <div className={c.subhead}>電解質</div>
      <p className={c.subheadNote}>直接秤量するか、母液を作って分注するかを選べます。</p>

      <div className={c.grid} style={{ marginBottom: 20 }}>
        <Field label="試薬" htmlFor="salt">
          <select
            id="salt"
            className={c.select}
            value={showCustom ? 'custom' : additive.reagentId}
            onChange={(e) => selectReagent(e.target.value)}
          >
            <option value="none">なし（無添加）</option>
            {reagents.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} {r.formula} — {r.mw.toFixed(2)}
              </option>
            ))}
            <option value="custom">＋ 試薬を登録…</option>
          </select>
        </Field>
        <Field label="投入方法">
          <Segmented
            options={['direct', 'stock'] as const}
            value={additive.method}
            onChange={(method) => setAdditive({ method })}
            labels={{ direct: '直接秤量', stock: '母液から分注' }}
            aria-label="投入方法"
          />
        </Field>
        {additive.method === 'direct' && (
          <Field label="秤量" htmlFor="salt-mg">
            <NumberField
              id="salt-mg"
              value={additive.directMg}
              min={0}
              step={1}
              unit="mg"
              onChange={(directMg) => setAdditive({ directMg })}
            />
          </Field>
        )}
      </div>

      {showCustom && (
        <ReagentForm
          onDone={(id) => {
            setShowCustom(false)
            selectReagent(id)
          }}
          onCancel={() => setShowCustom(false)}
        />
      )}

      {!showCustom && additive.method === 'stock' && (
        <div className={c.stock}>
          <div className={c.stockStep}>
            <span className={c.st}>STEP 1 — 母液をつくる</span>
            <div className={c.row}>
              <NumberField
                aria-label="秤量 g"
                value={additive.stockGram}
                min={0}
                step={0.1}
                onChange={(stockGram) => setAdditive({ stockGram })}
              />
              <span className={c.unit}>g（含量</span>
              <NumberField
                aria-label="含量 %"
                value={additive.stockPurityPct}
                min={1}
                max={100}
                step={0.1}
                style={{ maxWidth: 64 }}
                onChange={(stockPurityPct) => setAdditive({ stockPurityPct })}
              />
              <span className={c.unit}>%）を</span>
              <NumberField
                aria-label="溶媒量 mL"
                value={additive.stockVolumeMl}
                min={1}
                step={10}
                onChange={(stockVolumeMl) => setAdditive({ stockVolumeMl })}
              />
              <span className={c.unit}>mL の精製水に溶かす</span>
            </div>
            {additive.stockMolarityOverride !== null && (
              <div className={c.calib}>
                母液ライブラリから読込中（{additive.stockMolarityOverride.toFixed(3)} mol/L）。
                調合欄を編集すると解除されます。
              </div>
            )}
          </div>
          <div className={c.arrow} aria-hidden="true">
            ↓
          </div>
          <div className={c.stockStep}>
            <span className={c.st}>STEP 2 — 仕込み水に分注する</span>
            <div className={c.row}>
              <NumberField
                aria-label="滴数"
                value={additive.drops}
                min={0}
                step={1}
                onChange={(drops) => setAdditive({ drops })}
              />
              <span className={c.unit}>滴 ＝ {derived.doseMl.toFixed(3)} mL を</span>
              <span className={c.unit}>{volumeMl.toFixed(0)} mL</span>
              <span className={c.unit}>へ</span>
            </div>
            <div className={c.calib}>
              スポイトによって1滴の体積は 0.03〜0.06 mL とばらつきます。20滴の実測体積を
              入れると全部の計算が補正されます（この値は試薬ではなくスポイトに保存されます）。
              <div className={c.row}>
                <span className={c.unit}>20滴 =</span>
                <NumberField
                  aria-label="20滴の実測体積 mL"
                  value={additive.calibMlPer20}
                  min={0.1}
                  step={0.05}
                  onChange={setPipetteCalibration}
                />
                <span className={c.unit}>mL → 1滴 {derived.dropVolumeMl.toFixed(4)} mL</span>
              </div>
            </div>
          </div>
          <div className={c.stockOut}>
            母液 <b>{derived.stockMolarity.toFixed(3)}</b> mol/L　　仕込み後{' '}
            <b>{derived.finalMmolPerL.toFixed(2)}</b> mmol/L
            <div style={{ marginTop: 6, color: 'var(--ink2)' }}>
              実質 {derived.finalMg.toFixed(1)} mg ／ {derived.finalPpm.toFixed(0)} ppm
            </div>
          </div>
          <div className={c.stockLib}>
            <div className={c.row}>
              <button
                type="button"
                className={c.linkBtn}
                disabled={derived.stockMolarity <= 0 || !derived.reagent}
                onClick={() => {
                  if (derived.reagent) {
                    void saveStock(derived.stockMolarity, additive.stockVolumeMl, derived.reagent.id)
                  }
                }}
              >
                この母液をライブラリに保存
              </button>
            </div>
            {stocks.length > 0 && (
              <ul>
                {stocks.map((st) => (
                  <li key={st.id}>
                    <span className={c.tdJp}>{reagentName(st.reagentId)}</span>
                    <span>{st.molarity.toFixed(3)} mol/L</span>
                    <span>調製から {daysSince(st.preparedAt)} 日</span>
                    <span>残 {stockRemainingMl(st).toFixed(1)} mL</span>
                    <button type="button" className={c.linkBtn} onClick={() => applyStock(st)}>
                      使う
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {!showCustom && additive.method === 'stock' && (
        <div className={c.note}>
          <b>母液は濃度で保存される</b>ので、水量を変えても同じ mmol/L になる滴数を
          逆算できます（現在の水量で 1.00 mmol/L なら{' '}
          <b>{derived.neededDrops !== null ? derived.neededDrops.toFixed(0) : '—'}</b> 滴）。
        </div>
      )}

      <div className={c.subhead}>還元剤</div>
      <p className={c.subheadNote}>金コロイドでは金属イオンとのモル比が粒径をほぼ決めます。</p>
      <div className={c.grid}>
        <Field label="試薬" htmlFor="red">
          <select
            id="red"
            className={c.select}
            value={additive.reducerName}
            onChange={(e) => setAdditive({ reducerName: e.target.value })}
          >
            {Object.keys(REDUCERS).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </Field>
        <Field label="秤量" htmlFor="redmg">
          <NumberField
            id="redmg"
            value={additive.reducerMg}
            min={0}
            step={1}
            unit="mg"
            onChange={(reducerMg) => setAdditive({ reducerMg })}
          />
        </Field>
        <Field label="保護剤" jp="/ 分散安定" htmlFor="cap">
          <select
            id="cap"
            className={c.select}
            value={additive.capName}
            onChange={(e) => setAdditive({ capName: e.target.value })}
          >
            {['なし', 'PVP K30', 'ゼラチン', 'PEG 6000'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="投入タイミング">
          <Segmented
            options={TIMINGS}
            value={additive.timing}
            onChange={(timing) => setAdditive({ timing })}
            aria-label="投入タイミング"
          />
        </Field>
      </div>

      <div className={c.inverse}>
        <h3>モル比</h3>
        <p>還元剤 / 金属イオン（mol/mol）。この比が大きいほど粒径は小さくなります。</p>
        <div className={c.inverseOut}>
          {derived.molarRatio !== null ? derived.molarRatio.toFixed(1) : '—'} : 1
          <span>
            {additive.reducerName.replace(/（.*）/, '')} / {derived.metal.symbol}
          </span>
        </div>
      </div>
    </>
  )
}
