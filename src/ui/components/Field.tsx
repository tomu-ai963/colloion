import type { ReactNode } from 'react'
import c from './controls.module.css'

interface FieldProps {
  label: ReactNode
  /** ラベル横の日本語補足（モックの .jp） */
  jp?: ReactNode
  htmlFor?: string
  children: ReactNode
}

/** ラベル付きフィールド。htmlFor があれば <label>、なければ <span> */
export function Field({ label, jp, htmlFor, children }: FieldProps) {
  const inner = (
    <>
      {label}
      {jp && <span className={c.jp}> {jp}</span>}
    </>
  )
  return (
    <div className={c.field}>
      {htmlFor ? (
        <label className={c.lbl} htmlFor={htmlFor}>
          {inner}
        </label>
      ) : (
        <span className={c.lbl}>{inner}</span>
      )}
      {children}
    </div>
  )
}
