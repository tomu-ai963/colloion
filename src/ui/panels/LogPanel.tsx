import { METALS } from '../../core/metals'
import type { Batch, Verdict } from '../../core/model'
import { secondsToHM } from '../../core/units'
import { suggestEta } from '../../store/derive'
import { useAppStore } from '../../store/appStore'
import c from '../components/controls.module.css'

const VERDICTS: Verdict[] = ['—', '良', '凝集', '粒径大', '析出']

function conditionLabel(b: Batch): string {
  const { hours, minutes } = secondsToHM(b.power.durationSec)
  const vol = b.water.volumeMl >= 1000 ? `${b.water.volumeMl / 1000}L` : `${b.water.volumeMl}mL`
  return `${b.power.currentMa} mA × ${hours}:${String(minutes).padStart(2, '0')} / ${vol}`
}

function download(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function toCsv(batches: Batch[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const header = [
    'label', 'createdAt', 'mode', 'anode', 'volumeMl', 'currentMa', 'durationSec',
    'etaPct', 'theoreticalMg', 'theoreticalPpm', 'coulombs', 'currentDensity',
    'sessionCoulombs', 'sessionPpm',
    'measuredTds', 'measuredPh', 'colorNote', 'verdict',
  ]
  const rows = batches.map((b) =>
    [
      b.label, b.createdAt, b.mode, b.electrode.anode, b.water.volumeMl,
      b.power.currentMa, b.power.durationSec, b.power.eta,
      b.computed.mg.toFixed(2), b.computed.ppm.toFixed(2),
      b.computed.coulombs.toFixed(2), b.computed.currentDensity.toFixed(3),
      b.measured ? b.measured.coulombs.toFixed(2) : '',
      b.measured ? b.measured.ppm.toFixed(2) : '',
      b.result?.measuredTds ?? '', b.result?.measuredPh ?? '',
      b.result?.colorNote ?? '', b.result?.verdict ?? '',
    ]
      .map(esc)
      .join(','),
  )
  return [header.join(','), ...rows].join('\r\n')
}

export function LogPanel() {
  const batches = useAppStore((s) => s.batches)
  const updateResult = useAppStore((s) => s.updateResult)
  const deleteBatch = useAppStore((s) => s.deleteBatch)
  const setPower = useAppStore((s) => s.setPower)

  const etaSuggestion = suggestEta(batches)

  return (
    <>
      {batches.length === 0 ? (
        <p style={{ color: 'var(--ink2)', fontSize: 12.5 }}>
          まだ記録がありません。条件を組んでヘッダーの「バッチを保存」を押すと、
          保存時点の理論値がスナップショットとしてここに残ります。
        </p>
      ) : (
        <div className={c.logWrap}>
          <table className={c.log}>
            <thead>
              <tr>
                <th>バッチ</th>
                <th>金属</th>
                <th>条件</th>
                <th>理論</th>
                <th>実測 TDS</th>
                <th>色メモ</th>
                <th>判定</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const metal = METALS[b.electrode.anode]
                const alpha = Math.min(0.82, (b.computed.ppm / 38) * 0.82)
                return (
                  <tr key={b.id}>
                    <td>{b.label}</td>
                    <td className={c.tdJp}>
                      <span
                        className={c.swatch}
                        style={{ background: `rgba(${metal.colloidRgb},${alpha.toFixed(2)})` }}
                        aria-hidden="true"
                      />
                      {metal.nameJa}
                    </td>
                    <td>{conditionLabel(b)}</td>
                    <td>
                      {b.computed.ppm.toFixed(1)} ppm
                      {!metal.faradayValid && metal.symbol === 'Mg' && (
                        <span className={c.unit}>（下限）</span>
                      )}
                      {b.measured && (
                        <div className={c.unit}>
                          積算 {b.measured.ppm.toFixed(1)} ppm（η {b.measured.etaPct}% 仮）
                        </div>
                      )}
                    </td>
                    <td>
                      <input
                        type="number"
                        className={c.miniInput}
                        min={0}
                        step={1}
                        aria-label={`${b.label} の実測 TDS`}
                        value={b.result?.measuredTds ?? ''}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          void updateResult(b.id, {
                            measuredTds:
                              e.target.value === '' || !Number.isFinite(n) || n < 0
                                ? undefined
                                : n,
                          })
                        }}
                      />
                    </td>
                    <td className={c.tdJp}>
                      <input
                        type="text"
                        className={c.miniInput}
                        style={{ maxWidth: 110 }}
                        aria-label={`${b.label} の色メモ`}
                        value={b.result?.colorNote ?? ''}
                        placeholder="淡黄 など"
                        onChange={(e) => void updateResult(b.id, { colorNote: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className={c.miniSelect}
                        aria-label={`${b.label} の判定`}
                        value={b.result?.verdict ?? '—'}
                        onChange={(e) => void updateResult(b.id, { verdict: e.target.value as Verdict })}
                      >
                        {VERDICTS.map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button type="button" className={c.linkBtn} onClick={() => void deleteBatch(b.id)}>
                        削除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {etaSuggestion !== null && (
        <div className={c.note}>
          実測 TDS のある {batches.filter((b) => (b.result?.measuredTds ?? 0) > 0).length} 本から、
          電流効率 η の補正案は <b>{etaSuggestion}%</b>。
          TDS はイオン性金属しか見えないため、粒子化が進んだバッチでは低めに出ます。{' '}
          <button
            type="button"
            className={c.linkBtn}
            onClick={() => setPower({ eta: etaSuggestion })}
          >
            現在のバッチに適用する
          </button>
        </div>
      )}

      {batches.length > 0 && (
        <div className={c.row} style={{ marginTop: 22 }}>
          <button
            type="button"
            className={c.btnCancel}
            onClick={() =>
              download('colloion-batches.json', 'application/json', JSON.stringify(batches, null, 2))
            }
          >
            JSON エクスポート
          </button>
          <button
            type="button"
            className={c.btnCancel}
            onClick={() => download('colloion-batches.csv', 'text/csv', toCsv(batches))}
          >
            CSV エクスポート
          </button>
        </div>
      )}
    </>
  )
}
