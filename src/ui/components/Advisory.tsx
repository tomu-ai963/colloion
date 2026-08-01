import c from './controls.module.css'

interface AdvisoryProps {
  warn: boolean
  /** metals マスタの advisory（アプリ内定義の静的 HTML のみを渡す） */
  html: string
}

export function Advisory({ warn, html }: AdvisoryProps) {
  return (
    <div className={warn ? c.advisWarn : c.advis}>
      <span className={c.ah}>{warn ? 'CAUTION' : 'NOTE'}</span>
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
