/** JSON 相当の値の構造比較（キーの順序は問わない。undefined のキーは無いものとみなす） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b)
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined)
  const ak = keys(ao)
  const bk = keys(bo)
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]))
}
