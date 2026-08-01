interface RunBeakerProps {
  ppm: number
  /** 反転回数が奇数なら電極表示を入れ替える */
  flipped: boolean
}

const GOLD = '#D9B85C'
const BLUE = '#6E8BA8'

/** Run Mode のビーカー。極性反転で電極色と ± ラベルが入れ替わる */
export function RunBeaker({ ppm, flipped }: RunBeakerProps) {
  const alpha = Math.min(0.6, ppm / 34)
  const leftIsAnode = !flipped
  const cathodeX = leftIsAnode ? 92 : 60

  return (
    <svg
      width="150"
      height="172"
      viewBox="0 0 150 172"
      role="img"
      aria-label={`ビーカーの現在の状態。${leftIsAnode ? '左' : '右'}が陽極`}
    >
      <defs>
        <linearGradient id="run-beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="38%" stopColor="#fff" stopOpacity=".75" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="run-jar">
          <path d="M32 34 L32 146 Q32 156 42 156 L108 156 Q118 156 118 146 L118 34 Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#run-jar)">
        <rect x="28" y="62" width="94" height="98" fill={`rgba(217,184,92,${alpha.toFixed(3)})`} />
        <polygon points="28,98 122,84 122,116" fill="url(#run-beam)" opacity=".3" />
        <rect x="28" y="97" width="94" height="1.4" fill="#fff" opacity=".55" />
      </g>
      <path
        d="M32 34 L32 146 Q32 156 42 156 L108 156 Q118 156 118 146 L118 34"
        fill="none"
        stroke="#8A7433"
        strokeWidth="1"
      />
      <line x1="27" y1="34" x2="123" y2="34" stroke="#8A7433" strokeWidth="1" />
      <line x1="32" y1="62" x2="118" y2="62" stroke="#8A7433" strokeWidth=".6" opacity=".5" />
      <line
        x1="60" y1="12" x2="60" y2="130"
        stroke={leftIsAnode ? GOLD : BLUE}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <line
        x1="92" y1="12" x2="92" y2="130"
        stroke={leftIsAnode ? BLUE : GOLD}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <text x="60" y="7" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="8.5" fill={leftIsAnode ? GOLD : BLUE}>
        {leftIsAnode ? '＋' : '−'}
      </text>
      <text x="92" y="7" textAnchor="middle" fontFamily="ui-monospace,monospace" fontSize="8.5" fill={leftIsAnode ? BLUE : GOLD}>
        {leftIsAnode ? '−' : '＋'}
      </text>
      <g opacity=".5">
        <circle cx={cathodeX} cy="120" r="1.4" fill="#9A9488" />
        <circle cx={cathodeX + 2} cy="106" r="1.1" fill="#9A9488" />
        <circle cx={cathodeX - 2} cy="90" r="1.6" fill="#9A9488" />
        <circle cx={cathodeX + 1} cy="76" r="1.1" fill="#9A9488" />
      </g>
    </svg>
  )
}
