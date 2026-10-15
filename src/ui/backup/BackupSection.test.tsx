import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_FORMAT } from '../../storage/backup'
import { useAppStore } from '../../store/appStore'
import { LogPanel } from '../panels/LogPanel'

// jsdom には Blob.text が無い（実ブラウザにはある）ので FileReader で補う
if (!('text' in Blob.prototype)) {
  Object.defineProperty(Blob.prototype, 'text', {
    value(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.onerror = () => reject(r.error)
        r.readAsText(this)
      })
    },
  })
}

beforeEach(() => {
  useAppStore.setState({ batches: [] })
})
afterEach(cleanup)

const backupFile = (body: unknown) =>
  new File([JSON.stringify(body)], 'colloion-backup.json', { type: 'application/json' })

const batch = {
  id: 'ui-b1',
  label: '2026-1015-07',
  createdAt: '2026-10-15T01:00:00.000Z',
  updatedAt: 1000,
  mode: 'colloid',
  water: { volumeMl: 1000, type: '蒸留水', initialTds: 1, tempC: 24 },
  electrode: { anode: 'Ag', cathode: '銀 Ag', purity: '99.99%', areaCm2: 12, gapMm: 35, route: 'electrolysis' },
  additives: [],
  power: { mode: 'CC', currentMa: 1, voltageV: 24, durationSec: 10800, eta: 95, reversalMin: 15 },
  computed: { mg: 12.1, ppm: 12.1, coulombs: 10.8, currentDensity: 0.083 },
}

describe('BackupSection', () => {
  it('記録が無くても書き出し・読み込みのボタンが出る', () => {
    render(<LogPanel />)
    expect(screen.getByRole('button', { name: '全データを書き出す' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'バックアップを読み込む' })).toBeInTheDocument()
  })

  it('読み込むと件数を知らせ、記録の一覧に反映される', async () => {
    const user = userEvent.setup()
    render(<LogPanel />)
    await user.upload(
      screen.getByLabelText('バックアップファイル'),
      backupFile({ format: BACKUP_FORMAT, version: 1, exportedAt: '', batches: [batch, { id: 'broken' }] }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      '読み込みました（追加 1 件・更新 0 件・変化なし 0 件）。 形式が合わず読み込めなかったもの 1 件。',
    )
    expect(screen.getByText('2026-1015-07')).toBeInTheDocument()
  })

  it('colloion のファイルでなければ理由を出す', async () => {
    const user = userEvent.setup()
    render(<LogPanel />)
    await user.upload(screen.getByLabelText('バックアップファイル'), backupFile({ hello: 1 }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '読み込めませんでした: colloion のバックアップではありません。',
    )
  })
})
