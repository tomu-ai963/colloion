import { activeElapsedMs, sessionCoulombs } from '../../core/session'
import { formatDuration } from '../../core/units'
import { useRunStore } from '../../store/runStore'
import s from '../App.module.css'

/**
 * 起動時に status: running / paused のセッションが残っていたときの復帰ダイアログ。
 * 中断中に通電が続いていたかはアプリには分からないので、ユーザーに選ばせる。
 */
export function RecoveryDialog() {
  const recovery = useRunStore((st) => st.recovery)
  const integrityWarning = useRunStore((st) => st.integrityWarning)
  const applyRecovery = useRunStore((st) => st.applyRecovery)
  if (!recovery) return null

  const { session, batch } = recovery
  const lastAlive = new Date(session.updatedAt)
  const gapMin = Math.max(0, Math.round((Date.now() - session.updatedAt) / 60_000))
  const recordedMin = Math.round(activeElapsedMs(session, session.updatedAt) / 60_000 / 1) // 記録済みの通電時間

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <div className={s.modal}>
        <h2 id="recovery-title">前回の通電セッションが残っています</h2>
        <p>
          {batch ? `BATCH ${batch.label}` : '（元のバッチが見つかりません）'} ・ 最終記録{' '}
          {lastAlive.getMonth() + 1}/{lastAlive.getDate()}{' '}
          {lastAlive.getHours()}:{String(lastAlive.getMinutes()).padStart(2, '0')}（約 {gapMin} 分前）
          <br />
          記録済み: 通電 {formatDuration(recordedMin * 60)} ／ 積算{' '}
          {sessionCoulombs(session, session.updatedAt).toFixed(2)} C
        </p>
        <p>
          中断していた約 {gapMin} 分のあいだ、電源が入っていたかどうかをアプリは判定できません。
          実際の状態に合わせて選んでください。
        </p>
        {integrityWarning && (
          <p role="alert" style={{ color: 'var(--warn, #b4453c)' }}>
            注意: 保存されていた積算電荷（{integrityWarning.stored.toFixed(2)} C）と区間合計（
            {integrityWarning.recomputed.toFixed(2)} C）に乖離があります。
          </p>
        )}
        <div className={s.modalBtns}>
          <button type="button" className={s.btnSolid} onClick={() => void applyRecovery('energized')}>
            通電を続行 — 中断中も通電していた（電荷に含める）
          </button>
          <button type="button" className={s.btnSolid} onClick={() => void applyRecovery('stopped')}>
            通電を続行 — 中断中は止まっていた（停止時間として扱う）
          </button>
          <button type="button" className={s.btnGhost} onClick={() => void applyRecovery('ended')}>
            ここで終了として記録（最終記録時刻を終了時刻にする）
          </button>
          <button type="button" className={s.btnGhost} onClick={() => void applyRecovery('discard')}>
            破棄（記録に残さない）
          </button>
        </div>
      </div>
    </div>
  )
}
