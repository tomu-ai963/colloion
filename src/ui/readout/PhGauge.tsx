import r from './readout.module.css'

interface PhGaugeProps {
  ph: number
}

/** 水酸化物析出域のゲージ（イオンモードで表示） */
export function PhGauge({ ph }: PhGaugeProps) {
  const x = Math.round((ph / 14) * 272)
  const labelX = Math.min(250, Math.max(22, x))
  return (
    <div className={r.gauge}>
      <div className={r.gaugeLbl}>水酸化物の析出域</div>
      <svg
        width="100%"
        height="34"
        viewBox="0 0 272 34"
        preserveAspectRatio="none"
        role="img"
        aria-label={`pH ${ph.toFixed(1)} 以上で水酸化物が析出する目安`}
      >
        <rect x="0" y="8" width="272" height="10" fill="#F0EEE6" />
        <rect x="0" y="8" width={x} height="10" fill="#FBF6E9" />
        <rect x={x} y="8" width={272 - x} height="10" fill="rgba(180,69,60,.22)" />
        <line x1={x} y1="3" x2={x} y2="23" stroke="#A8842C" strokeWidth="1.6" />
        <text x={labelX} y="32" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="9" fill="#A8842C">
          pH {ph.toFixed(1)}
        </text>
      </svg>
      <div className={r.gaugeScale}>
        <span>0</span>
        <span>4</span>
        <span>7</span>
        <span>10</span>
        <span>14</span>
      </div>
    </div>
  )
}
