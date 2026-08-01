import {
  activeElapsedAtTime,
  activeElapsedMs,
  chartSeries,
  openSegment,
  reversalPositionsMs,
  type Session,
} from '../../core/session'

interface RunChartProps {
  session: Session
  now: number
  /** 電荷 [C] → ppm の係数（eq × η/100 ÷ L） */
  ppmPerCoulomb: number
  targetPpm: number
}

const W = 720
const H = 190
const DATA_RIGHT = 540 // データはここまで。右側は予測の外挿領域

const GOLD = '#D9B85C'
const BLUE = '#6E8BA8'
const TAUPE = '#8A7C6A'

/**
 * 濃度・電流・電圧の推移。系列は区間境界から生成される折れ線
 * （全秒サンプルはしない）。右端の破線は現在の電流が続く前提の外挿（予測）。
 */
export function RunChart({ session, now, ppmPerCoulomb, targetPpm }: RunChartProps) {
  const points = chartSeries(session, now)
  const totalMs = Math.max(1, activeElapsedMs(session, now))
  const x = (elapsedMs: number) => (elapsedMs / totalMs) * DATA_RIGHT

  const currentPpm = (points[points.length - 1]?.ppmCoulombs ?? 0) * ppmPerCoulomb
  const ppmMax = Math.max(targetPpm, currentPpm, 0.1) * 1.08
  const yPpm = (v: number) => 178 - (v / ppmMax) * 160

  const curMax = Math.max(...points.map((p) => p.currentMa), 0.1) * 1.25
  const yCur = (v: number) => 112 - (v / curMax) * 48

  const volts = points.filter((p) => p.voltageV !== undefined)
  const voltMax = volts.length > 0 ? Math.max(...volts.map((p) => p.voltageV!)) * 1.2 : 0
  const yVolt = (v: number) => 152 - (v / voltMax) * 48

  const ppmLine = points.map((p) => `${x(p.elapsedMs).toFixed(1)},${yPpm(p.ppmCoulombs * ppmPerCoulomb).toFixed(1)}`).join(' ')
  const curLine = points.map((p) => `${x(p.elapsedMs).toFixed(1)},${yCur(p.currentMa).toFixed(1)}`).join(' ')
  const voltLine =
    voltMax > 0
      ? points
          .filter((p) => p.voltageV !== undefined)
          .map((p) => `${x(p.elapsedMs).toFixed(1)},${yVolt(p.voltageV!).toFixed(1)}`)
          .join(' ')
      : null

  // 予測: 現在の電流が続く前提の外挿。x 軸スケールをそのまま右へ延長する
  const open = openSegment(session)
  const lastY = yPpm(currentPpm)
  let projection: string | null = null
  if (open && session.status === 'running') {
    const ppmPerMs = ((open.currentMa / 1000) * ppmPerCoulomb) / 1000
    const extraMs = ((W - 20 - DATA_RIGHT) / DATA_RIGHT) * totalMs
    const projPpm = currentPpm + ppmPerMs * extraMs
    projection = `${DATA_RIGHT},${lastY.toFixed(1)} ${W - 20},${yPpm(projPpm).toFixed(1)}`
  }

  const reversals = reversalPositionsMs(session)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label="濃度・電流・電圧の時間推移。破線の延長は現在の電流が続く前提の予測"
    >
      <g stroke="var(--line)" strokeWidth=".8">
        <line x1="0" y1="20" x2={W} y2="20" />
        <line x1="0" y1="65" x2={W} y2="65" />
        <line x1="0" y1="110" x2={W} y2="110" />
        <line x1="0" y1="155" x2={W} y2="155" />
      </g>

      {/* 目標濃度ライン */}
      <line x1="0" y1={yPpm(targetPpm)} x2={DATA_RIGHT} y2={yPpm(targetPpm)} stroke={GOLD} strokeWidth=".6" strokeDasharray="1 5" opacity=".5" />

      {/* 極性反転マーカー */}
      <g stroke="#8A7433" strokeWidth=".8" strokeDasharray="2 4" opacity=".7">
        {reversals.map((ms, i) => (
          <line key={i} x1={x(ms)} y1="8" x2={x(ms)} y2="170" />
        ))}
      </g>

      {voltLine && <polyline fill="none" stroke={TAUPE} strokeWidth="1.2" opacity=".75" points={voltLine} />}
      <polyline fill="none" stroke={BLUE} strokeWidth="1.4" points={curLine} />
      <polyline fill="none" stroke={GOLD} strokeWidth="1.8" strokeLinejoin="round" points={ppmLine} />

      <circle cx={DATA_RIGHT} cy={lastY} r="3.2" fill={GOLD} />
      <line x1={DATA_RIGHT} y1="8" x2={DATA_RIGHT} y2="178" stroke={GOLD} strokeWidth=".7" opacity=".35" />
      <text x={DATA_RIGHT + 6} y={Math.max(14, lastY - 4)} fontFamily="ui-monospace,monospace" fontSize="10" fill={GOLD}>
        {currentPpm.toFixed(1)} ppm
      </text>

      {projection && (
        <>
          <polyline fill="none" stroke={GOLD} strokeWidth="1.2" strokeDasharray="3 4" opacity=".45" points={projection} />
          <text x={W - 108} y="34" fontFamily="ui-monospace,monospace" fontSize="9" fill="var(--ink3)">
            予測（現在の電流が続く前提）
          </text>
        </>
      )}

      {/* マークのピン */}
      {session.marks.map((m, i) => {
        const mx = x(activeElapsedAtTime(session, m.at))
        return (
          <g key={i}>
            <polygon points={`${mx - 4},178 ${mx + 4},178 ${mx},170`} fill="var(--ink2)">
              <title>
                {m.kind === 'temp' ? `液温 ${m.value ?? ''}°C` : m.kind === 'ph' ? `pH ${m.value ?? ''}` : (m.text ?? 'メモ')}
              </title>
            </polygon>
          </g>
        )
      })}
    </svg>
  )
}
