import c from './controls.module.css'

interface SegmentedProps<T extends string> {
  options: readonly T[]
  value: T
  onChange(value: T): void
  labels?: Partial<Record<T, string>>
  'aria-label'?: string
}

/** モックの .seg 相当。トグルは aria-pressed で表現 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  labels,
  'aria-label': ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className={c.seg} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={opt === value}
          onClick={() => onChange(opt)}
        >
          {labels?.[opt] ?? opt}
        </button>
      ))}
    </div>
  )
}
