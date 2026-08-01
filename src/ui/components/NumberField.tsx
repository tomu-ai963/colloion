import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { clamp } from '../../core/units'
import c from './controls.module.css'

interface NumberFieldProps {
  id?: string
  value: number
  onChange(value: number): void
  min?: number
  max?: number
  step?: number
  unit?: string
  style?: CSSProperties
  'aria-label'?: string
}

/**
 * 数値入力。空文字・NaN・範囲外は「計算にはクランプ値を渡しつつ」
 * 入力欄には赤枠とメッセージを出す（parseFloat || 0 の素通しはしない）。
 */
export function NumberField({
  id,
  value,
  onChange,
  min = 0,
  max,
  step,
  unit,
  style,
  'aria-label': ariaLabel,
}: NumberFieldProps) {
  const [raw, setRaw] = useState(String(value))
  const [invalid, setInvalid] = useState<string | null>(null)
  const focused = useRef(false)

  // 外部から値が変わったら（チップ・逆算反映など）表示も追従する
  useEffect(() => {
    if (!focused.current) {
      setRaw(String(value))
      setInvalid(null)
    }
  }, [value])

  const upper = max ?? Number.POSITIVE_INFINITY

  const handle = (text: string) => {
    setRaw(text)
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) {
      setInvalid('数値を入力してください')
      onChange(clamp(min, min, upper))
    } else if (n < min || n > upper) {
      setInvalid(max !== undefined ? `${min}〜${max} の範囲で入力` : `${min} 以上で入力`)
      onChange(clamp(n, min, upper))
    } else {
      setInvalid(null)
      onChange(n)
    }
  }

  const input = (
    <input
      type="number"
      className={c.input}
      id={id}
      value={raw}
      min={min}
      max={max}
      step={step}
      style={style}
      aria-label={ariaLabel}
      aria-invalid={invalid !== null}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        setRaw(String(value))
        setInvalid(null)
      }}
      onChange={(e) => handle(e.target.value)}
    />
  )

  return (
    <>
      {unit !== undefined ? (
        <div className={c.unitRow}>
          {input}
          <span className={c.unit}>{unit}</span>
        </div>
      ) : (
        input
      )}
      {invalid && <div className={c.invalidMsg}>{invalid}</div>}
    </>
  )
}
