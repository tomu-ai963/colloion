import { useEffect, useState } from 'react'
import { electrochemicalEquivalent, METALS } from '../../core/metals'
import {
  activeElapsedMs,
  averageCurrentMa,
  coulombsAt,
  energyWh,
  msUntilReversal,
  openSegment,
  polarityFlipped,
  reversalCount,
  segmentCoulombs,
  segmentDurationMs,
  sessionCoulombs,
  type MarkKind,
  type Segment,
} from '../../core/session'
import { useRunStore } from '../../store/runStore'
import { RunBeaker } from './RunBeaker'
import { RunChart } from './RunChart'
import { useWakeLock } from './useWakeLock'
import r from './run.module.css'

const pad = (n: number) => String(n).padStart(2, '0')

const fmtClock = (epochMs: number) => {
  const d = new Date(epochMs)
  return `${d.getHours()}:${pad(d.getMinutes())}`
}
const fmtClockSec = (epochMs: number) => {
  const d = new Date(epochMs)
  return `${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const fmtDur = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

const SEGMENT_REASON_LABEL: Record<Segment['reason'], string> = {
  start: '立ち上げ',
  current_change: '電流変更',
  voltage_change: '電圧変更',
  reversal: '極性反転',
  resume: '再開',
  manual: '手動',
}

const MARK_KINDS: { value: MarkKind; label: string }[] = [
  { value: 'temp', label: '液温 °C' },
  { value: 'ph', label: 'pH' },
  { value: 'observation', label: '観察' },
  { value: 'note', label: 'メモ' },
]

function MarkForm({ onClose }: { onClose(): void }) {
  const recordMark = useRunStore((s) => s.recordMark)
  const [kind, setKind] = useState<MarkKind>('temp')
  const [value, setValue] = useState('')
  const [text, setText] = useState('')
  const numeric = kind === 'temp' || kind === 'ph'

  const save = async () => {
    const n = Number(value)
    await recordMark({
      kind,
      value: numeric && value.trim() !== '' && Number.isFinite(n) ? n : undefined,
      text: text.trim() || undefined,
    })
    onClose()
  }

  return (
    <div className={r.markForm}>
      <label htmlFor="mark-kind">マーク</label>
      <select id="mark-kind" className={r.select} value={kind} onChange={(e) => setKind(e.target.value as MarkKind)}>
        {MARK_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      {numeric && (
        <input
          type="number"
          className={r.input}
          aria-label="値"
          value={value}
          step={0.1}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <input
        type="text"
        className={r.inputWide}
        aria-label="メモ"
        placeholder="観察メモ（任意）"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" className={r.btnPrimary} onClick={() => void save()}>
        記録する
      </button>
      <button type="button" className={r.btnGhost} onClick={onClose}>
        閉じる
      </button>
    </div>
  )
}

export function RunScreen({ onExit }: { onExit(): void }) {
  const session = useRunStore((s) => s.session)
  const batch = useRunStore((s) => s.batch)
  const now = useRunStore((s) => s.now)
  const reversalNoticeAt = useRunStore((s) => s.reversalNoticeAt)
  const integrityWarning = useRunStore((s) => s.integrityWarning)
  const dismissReversalNotice = useRunStore((s) => s.dismissReversalNotice)

  const [dim, setDim] = useState(false)
  const [showMarkForm, setShowMarkForm] = useState(false)
  const [curInput, setCurInput] = useState('')
  const [voltInput, setVoltInput] = useState('')
  const wakeLock = useWakeLock(session !== null)

  const running = session?.status === 'running'

  // 描画更新のトリガーとしてのみ interval を使う（計時の真実は Date.now 差分）。
  // タブ復帰時は visibilitychange で即座に再計算して画面を合わせる。
  useEffect(() => {
    if (!session) return
    const tick = () => useRunStore.getState().tick()
    tick()
    const id = setInterval(tick, 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 実行中のみ、離脱時に警告
  useEffect(() => {
    if (!running) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [running])

  if (!session || !batch) return null

  const metal = METALS[batch.electrode.anode]
  const eq = electrochemicalEquivalent(metal)
  const eta = batch.power.eta
  const volL = batch.water.volumeMl / 1000
  const ppmPerCoulomb = volL > 0 ? (eq * (eta / 100)) / volL : 0

  const coulombs = sessionCoulombs(session, now)
  const mg = eq * coulombs * (eta / 100)
  const ppm = volL > 0 ? mg / volL : 0

  const activeMs = activeElapsedMs(session, now)
  const durationMs = batch.power.durationSec * 1000
  const remainMs = Math.max(0, durationMs - activeMs)
  const targetPpm = batch.computed.ppm
  const pct = Math.min(100, durationMs > 0 ? (activeMs / durationMs) * 100 : 0)

  const eh = Math.floor(activeMs / 3_600_000)
  const em = Math.floor((activeMs % 3_600_000) / 60_000)
  const es = Math.floor((activeMs % 60_000) / 1000)

  const open = openSegment(session)
  const untilReversal = msUntilReversal(session, now, batch.power.reversalMin)
  const flips = reversalCount(session)

  const temps = session.marks.filter((m) => m.kind === 'temp' && m.value !== undefined)
  const latestTemp = temps[temps.length - 1]
  const tempDelta = temps.length >= 2 ? latestTemp!.value! - temps[0]!.value! : null

  const wh = energyWh(session, now)

  const changeSettings = () => {
    const cur = Number(curInput)
    const volt = Number(voltInput)
    const open2 = openSegment(session)
    void useRunStore
      .getState()
      .changeSettings(
        Number.isFinite(cur) && cur > 0 ? cur : (open2?.currentMa ?? batch.power.currentMa),
        Number.isFinite(volt) && volt > 0 ? volt : (open2?.voltageV ?? batch.power.voltageV),
      )
    setCurInput('')
    setVoltInput('')
  }

  const endRun = async () => {
    const ok = window.confirm(
      '通電を終了して記録しますか？\nセッション積算に基づく実測ベースの値がバッチに書き戻されます（理論値は残ります）。',
    )
    if (!ok) return
    await useRunStore.getState().end()
    onExit()
  }

  const segmentsDesc = [...session.segments].reverse()

  return (
    <div className={dim ? `${r.root} ${r.dim}` : r.root}>
      <header className={r.bar}>
        <span className={r.name}>Colloion</span>
        <span className={r.pill}>
          <span className={running ? r.dot : r.dotPaused} />
          {running ? '通電中' : session.status === 'paused' ? '停止中' : '終了'}
        </span>
        <span className={r.id}>
          BATCH {batch.label} ・ {metal.nameJa} / {open?.currentMa ?? batch.power.currentMa} mA{' '}
          {batch.power.mode} / {batch.water.volumeMl} mL
        </span>
        <div className={r.barRight}>
          <button
            type="button"
            className={r.icobtn}
            aria-pressed={wakeLock.state === 'on'}
            disabled={wakeLock.state === 'unsupported'}
            onClick={wakeLock.toggle}
            title={
              wakeLock.state === 'unsupported'
                ? 'このブラウザは Screen Wake Lock に対応していません'
                : wakeLock.state === 'failed'
                  ? '取得に失敗しました。タブがアクティブか確認してください'
                  : undefined
            }
          >
            {wakeLock.state === 'unsupported'
              ? '画面ロック解除 非対応'
              : wakeLock.state === 'failed'
                ? '画面ロック解除 失敗'
                : `画面ロック解除 ${wakeLock.state === 'on' ? 'ON' : 'OFF'}`}
          </button>
          <button type="button" className={r.icobtn} aria-pressed={dim} onClick={() => setDim(!dim)}>
            減光
          </button>
        </div>
      </header>

      {integrityWarning && (
        <div className={r.bannerWarn} role="alert">
          <b>INTEGRITY</b>
          保存されていた積算電荷（{integrityWarning.stored.toFixed(2)} C）と区間合計（
          {integrityWarning.recomputed.toFixed(2)} C）に乖離があります。区間データを優先して表示しています。
        </div>
      )}

      {reversalNoticeAt !== null && now - reversalNoticeAt < 90_000 && (
        <div className={r.banner} role="status">
          <b>REVERSAL</b>
          極性反転の時刻です。反転は電源側の機能です — 装置側で反転されたことを確認してください。
          <button type="button" className={r.bannerClose} onClick={dismissReversalNotice}>
            閉じる
          </button>
        </div>
      )}

      <div className={r.wrap}>
        <main className={r.main}>
          <div className={r.hero}>
            <div>
              <div className={r.elapsedLbl}>経過時間（通電）</div>
              <div className={r.elapsed}>
                {eh}:{pad(em)}
                <span className={r.elapsedS}>:{pad(es)}</span>
              </div>
            </div>
            <div className={r.remain}>
              <div className={r.remainL}>残り</div>
              <div className={r.remainV}>
                {Math.floor(remainMs / 3_600_000)} 時間 {Math.floor((remainMs % 3_600_000) / 60_000)} 分
              </div>
              <div className={r.remainEta}>
                {running ? `終了 ${fmtClock(now + remainMs)} 予定（予測）` : '一時停止中'}
              </div>
            </div>
          </div>

          <div className={r.prog}>
            <div className={r.progTrack}>
              <div className={r.progFill} style={{ width: `${pct}%` }} />
            </div>
            <div className={r.progMeta}>
              <span>
                目標 <b>{targetPpm.toFixed(1)} ppm</b>（理論）
              </span>
              <span>
                {pct.toFixed(0)}% ・ {ppm.toFixed(1)} ppm 到達
              </span>
              <span>{fmtDur(durationMs)}</span>
            </div>
          </div>

          <dl className={r.figs}>
            <div className={`${r.fig} ${r.figLive}`}>
              <dt>現在濃度</dt>
              <dd>
                {ppm.toFixed(1)}
                <span className={r.figU}>ppm</span>
              </dd>
              <div className={r.figSub}>積算ベース ・ η 仮</div>
            </div>
            <div className={`${r.fig} ${r.figLive}`}>
              <dt>積算電荷</dt>
              <dd>
                {coulombs.toFixed(2)}
                <span className={r.figU}>C</span>
              </dd>
              <div className={r.figSub}>区間合計</div>
            </div>
            <div className={r.fig}>
              <dt>電流</dt>
              <dd>
                {(open?.currentMa ?? 0).toFixed(2)}
                <span className={r.figU}>mA</span>
              </dd>
              <div className={r.figSub}>初期設定 {batch.power.currentMa.toFixed(2)}</div>
            </div>
            <div className={r.fig}>
              <dt>電圧</dt>
              <dd>
                {open?.voltageV !== undefined ? open.voltageV.toFixed(1) : '—'}
                <span className={r.figU}>V</span>
              </dd>
              <div className={r.figSub}>上限 {batch.power.voltageV}</div>
            </div>
            <div className={r.fig}>
              <dt>溶出量</dt>
              <dd>
                {mg.toFixed(1)}
                <span className={r.figU}>mg</span>
              </dd>
              <div className={r.figSub}>η {eta}%（仮）</div>
            </div>
          </dl>

          <div className={r.chartHead}>
            <h2>推移</h2>
            <span>{fmtDur(activeMs)}</span>
            <div className={r.legend}>
              <span>
                <i style={{ background: '#D9B85C' }} />
                濃度
              </span>
              <span>
                <i style={{ background: '#6E8BA8' }} />
                電流
              </span>
              <span>
                <i style={{ background: '#8A7C6A' }} />
                電圧
              </span>
            </div>
          </div>
          <div className={r.chart}>
            <RunChart session={session} now={now} ppmPerCoulomb={ppmPerCoulomb} targetPpm={targetPpm} />
          </div>

          <div className={r.segHead}>
            <h2>区間ログ</h2>
            <span>電流・電圧が変わるたびに自動で区切られます（追記のみ）</span>
          </div>
          <table className={r.segs}>
            <thead>
              <tr>
                <th>#</th>
                <th>開始</th>
                <th>長さ</th>
                <th>電流</th>
                <th>電荷</th>
                <th>累計 ppm</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {segmentsDesc.map((seg) => {
                const isOpen = seg.endedAt === undefined
                const cumPpm = coulombsAt(session, seg.endedAt ?? now) * ppmPerCoulomb
                return (
                  <tr key={seg.index} className={isOpen ? r.nowRow : undefined}>
                    <td className={isOpen ? undefined : r.tdDim}>{pad(seg.index + 1)}</td>
                    <td className={isOpen ? undefined : r.tdDim}>{fmtClockSec(seg.startedAt)}</td>
                    <td>{fmtDur(segmentDurationMs(seg, now))}</td>
                    <td>{seg.currentMa.toFixed(2)} mA</td>
                    <td>{segmentCoulombs(seg, now).toFixed(2)} C</td>
                    <td>{cumPpm.toFixed(1)}</td>
                    <td>
                      <span className={isOpen || seg.reason === 'reversal' ? r.evtRev : r.evt}>
                        {isOpen ? '継続中' : SEGMENT_REASON_LABEL[seg.reason]}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </main>

        <aside className={r.side}>
          <div>
            <div className={r.cd}>
              <div className={r.cdL}>次の極性反転まで</div>
              <div className={r.cdV}>
                {untilReversal !== null
                  ? `${Math.floor(untilReversal / 60_000)}:${pad(Math.floor((untilReversal % 60_000) / 1000))}`
                  : '—'}
              </div>
              <div className={r.cdN}>
                {batch.power.reversalMin > 0
                  ? `${batch.power.reversalMin}分ごと ・ 通算 ${flips} 回（反転は電源側で実施）`
                  : '反転なし設定'}
              </div>
            </div>

            <div className={r.beaker}>
              <RunBeaker ppm={ppm} flipped={polarityFlipped(session)} />
            </div>
            <div className={r.cap}>
              陰極側に水素
              {latestTemp ? ` ・ 液温 ${latestTemp.value!.toFixed(1)}°C` : ''}
            </div>
          </div>

          <div className={r.statsG}>
            <div className={r.shead}>セッション</div>
            <dl style={{ margin: 0 }}>
              <div className={r.srow}>
                <dt>平均電流</dt>
                <dd>{averageCurrentMa(session, now).toFixed(2)} mA</dd>
              </div>
              <div className={r.srow}>
                <dt>実効 η</dt>
                <dd>{eta} %（仮）</dd>
              </div>
              <div className={r.srow}>
                <dt>電流密度</dt>
                <dd>
                  {batch.electrode.areaCm2 > 0
                    ? ((open?.currentMa ?? 0) / batch.electrode.areaCm2).toFixed(3)
                    : '—'}{' '}
                  mA/cm²
                </dd>
              </div>
              {latestTemp && (
                <div className={r.srow}>
                  <dt>液温（手入力）</dt>
                  <dd>
                    {latestTemp.value!.toFixed(1)} °C{' '}
                    {tempDelta !== null && tempDelta > 0 && (
                      <span className={r.deltaUp}>↑{tempDelta.toFixed(1)}</span>
                    )}
                  </dd>
                </div>
              )}
              {wh > 0 && (
                <div className={r.srow}>
                  <dt>投入電力量</dt>
                  <dd>{wh.toFixed(3)} Wh</dd>
                </div>
              )}
            </dl>

            {tempDelta !== null && tempDelta >= 2 && (
              <div className={r.alert} role="status">
                <b>WATCH</b>
                液温が最初の記録より {tempDelta.toFixed(1)}°C 上昇しています。同じ電圧でも導電率が
                上がるため、CC 運転でも電極表面の反応条件が変わり粒径に影響することがあります。
                観察の記録として残してください。
              </div>
            )}
          </div>
        </aside>
      </div>

      {showMarkForm && <MarkForm onClose={() => setShowMarkForm(false)} />}

      <div className={r.dock}>
        <button
          type="button"
          className={r.btnPrimary}
          onClick={() => void (running ? useRunStore.getState().pause() : useRunStore.getState().resume())}
        >
          {running ? '一時停止' : '再開'}
        </button>
        <button type="button" className={r.btn} onClick={() => setShowMarkForm((v) => !v)}>
          マークを記録
        </button>
        <button type="button" className={r.btnGhost} onClick={() => void endRun()}>
          通電を終了
        </button>
        <div className={r.adj}>
          <label htmlFor="setcur">電流を変更</label>
          <input
            type="number"
            className={r.input}
            id="setcur"
            step={0.05}
            min={0.05}
            placeholder={(open?.currentMa ?? batch.power.currentMa).toFixed(2)}
            value={curInput}
            disabled={!running}
            onChange={(e) => setCurInput(e.target.value)}
          />
          <label htmlFor="setvolt">電圧</label>
          <input
            type="number"
            className={r.input}
            id="setvolt"
            step={1}
            min={1}
            placeholder={String(open?.voltageV ?? batch.power.voltageV)}
            value={voltInput}
            disabled={!running}
            onChange={(e) => setVoltInput(e.target.value)}
          />
          <button type="button" className={r.btn} disabled={!running} onClick={changeSettings}>
            適用して区間を切る
          </button>
        </div>
      </div>
    </div>
  )
}
