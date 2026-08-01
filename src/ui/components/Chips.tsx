import c from './controls.module.css'

interface ChipsProps {
  values: readonly number[]
  onPick(value: number): void
  format?(value: number): string
}

/** 数値プリセットのチップ列 */
export function Chips({ values, onPick, format }: ChipsProps) {
  return (
    <div className={c.chips}>
      {values.map((v) => (
        <button key={v} type="button" className={c.chip} onClick={() => onPick(v)}>
          {format ? format(v) : String(v)}
        </button>
      ))}
    </div>
  )
}
