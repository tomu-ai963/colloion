import type { Mode } from '../../core/model'

interface BeakerProps {
  mode: Mode
  /** 'r,g,b' */
  rgb: string
  ppm: number
  volumeMl: number
}

/**
 * ビーカー断面とチンダル光条のプレビュー。
 * イオンモードでは光条を消す — 真の溶液は光を散乱しないため、演出ではなく仕様。
 */
export function Beaker({ mode, rgb, ppm, volumeMl }: BeakerProps) {
  const alpha = Math.min(0.82, (ppm / 38) * 0.82)
  const level = 178 - Math.min(100, 26 + (volumeMl / 1000) * 74)
  const beam = mode === 'ion' ? 0 : Math.min(0.95, ppm / 22)

  return (
    <svg
      width="176"
      height="196"
      viewBox="0 0 176 196"
      role="img"
      aria-label={
        mode === 'ion'
          ? 'ビーカー断面。イオン溶液のためチンダル光条は見えない'
          : 'ビーカー断面とチンダル現象のプレビュー'
      }
    >
      <defs>
        <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="35%" stopColor="#fff" stopOpacity=".9" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="jar">
          <path d="M44 46 L44 168 Q44 178 54 178 L122 178 Q132 178 132 168 L132 46 Z" />
        </clipPath>
      </defs>

      <g clipPath="url(#jar)">
        <rect
          x="40"
          y={level}
          width="96"
          height={182 - level}
          fill={`rgba(${rgb},${alpha.toFixed(3)})`}
        />
        <polygon points="40,112 136,96 136,132" fill="url(#beam)" opacity={beam.toFixed(2)} />
        <rect
          x="40"
          y="111"
          width="96"
          height="1.6"
          fill="#fff"
          opacity={mode === 'ion' ? 0.12 : Number((beam * 0.9).toFixed(2))}
        />
      </g>

      <path
        d="M44 46 L44 168 Q44 178 54 178 L122 178 Q132 178 132 168 L132 46"
        fill="none"
        stroke="#A8842C"
        strokeWidth="1.1"
      />
      <line x1="38" y1="46" x2="138" y2="46" stroke="#A8842C" strokeWidth="1.1" />
      <line x1="44" y1={level} x2="132" y2={level} stroke="#A8842C" strokeWidth=".7" opacity=".55" />
      <g stroke="#A8842C" strokeWidth=".6" opacity=".38">
        <line x1="44" y1="98" x2="56" y2="98" />
        <line x1="44" y1="126" x2="56" y2="126" />
        <line x1="44" y1="154" x2="52" y2="154" />
      </g>
      <line x1="70" y1="18" x2="70" y2="150" stroke="#A8842C" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="106" y1="18" x2="106" y2="150" stroke="#8E9299" strokeWidth="2.4" strokeLinecap="round" />
      <text x="70" y="12" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="9" fill="#A8842C">
        ＋
      </text>
      <text x="106" y="12" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="9" fill="#8E9299">
        −
      </text>
      <circle cx="26" cy="112" r="2.6" fill="#A8842C" />
      <line x1="29" y1="112" x2="42" y2="112" stroke="#A8842C" strokeWidth=".8" opacity=".6" />
    </svg>
  )
}
