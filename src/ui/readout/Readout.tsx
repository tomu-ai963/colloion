import type { Mode } from '../../core/model'
import type { Derived } from '../../store/derive'
import { Beaker } from './Beaker'
import { PhGauge } from './PhGauge'
import r from './readout.module.css'

interface ReadoutProps {
  mode: Mode
  derived: Derived
  eta: number
  volumeMl: number
}

/** 右パネル: 常時表示のライブ計算結果。数値はすべて理論値・推定値（実測は記録タブ） */
export function Readout({ mode, derived: d, eta, volumeMl }: ReadoutProps) {
  const m = d.metal
  const etaHint =
    m.etaRange[1] > 0 ? `実測レンジ ${m.etaRange[0]}–${m.etaRange[1]}%` : '—'

  return (
    <aside className={r.readout} aria-label="ライブ計算結果">
      <div>
        <div className={r.beakerWrap}>
          <Beaker mode={mode} rgb={m.colloidRgb} ppm={d.ppm} volumeMl={volumeMl} />
        </div>
        <div className={r.tyndallCaption}>
          {mode === 'ion' ? 'イオン溶液 — チンダル現象なし' : 'TYNDALL PREVIEW'}
        </div>

        <div className={r.bigLbl}>{m.faradayValid ? '理論濃度' : '理論濃度（下限）'}</div>
        <div className={r.big}>
          {d.ppm.toFixed(1)}
          <span className={r.bigUnit}>ppm</span>
        </div>

        <dl className={r.stats}>
          <div className={r.stat}>
            <dt>溶出量（{m.faradayValid ? '理論' : '理論下限'}）</dt>
            <dd>{d.mg.toFixed(1)} mg</dd>
          </div>
          <div className={r.stat}>
            <dt>積算電荷</dt>
            <dd>{d.coulombs.toFixed(1)} C</dd>
          </div>
          <div className={r.stat}>
            <dt>電流密度</dt>
            <dd>{d.cd.toFixed(2)} mA/cm²</dd>
          </div>
          {mode === 'colloid' && (
            <div className={r.stat}>
              <dt>推定粒径（近似式）</dt>
              <dd>{d.particleNm} nm</dd>
            </div>
          )}
          <div className={r.stat}>
            <dt>
              電流効率 η
              <br />
              <span className={r.statHint}>{etaHint}</span>
            </dt>
            <dd className={eta > 100 ? r.etaOver : undefined}>{eta} %</dd>
          </div>
        </dl>

        {mode === 'ion' && <PhGauge ph={m.hydroxidePh} />}

        <p className={r.tdsNote}>
          {mode === 'ion' ? (
            <>
              イオン溶液は TDS がそのまま濃度に対応します。<strong>濁りが出たら析出</strong>
              のサインなので、pH を下げるか錯化剤を足してください。
            </>
          ) : (
            <>
              TDS メーターは導電率、つまり<strong>イオン性の金属だけ</strong>
              を見ています。粒子化が進むほど数値は下がるので、TDS が伸びない＝失敗ではありません。
            </>
          )}
        </p>
      </div>
    </aside>
  )
}
