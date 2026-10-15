import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../store/appStore'
import { App } from './App'

// テストごとにストアのドラフトをリセットする
beforeEach(() => {
  useAppStore.getState().newBatch()
  useAppStore.setState({ mode: 'colloid', batches: [] })
})
afterEach(cleanup)

describe('App', () => {
  it('ブランドとレール（作業順のタブ）が表示される', () => {
    render(<App />)
    expect(screen.getByText('コロイド電解ノート')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['01水', '02電極', '03添加物', '04通電', '05記録'])
  })

  it('コロイド ⇄ イオンでチンダル表示が切り替わる', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByText('TYNDALL PREVIEW')).toBeInTheDocument()
    expect(screen.getByText(/推定粒径/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'イオン' }))
    expect(screen.getByText('イオン溶液 — チンダル現象なし')).toBeInTheDocument()
    // 真の溶液は光を散乱しない: 粒径は隠れ、析出域ゲージが出る
    expect(screen.queryByText(/推定粒径/)).not.toBeInTheDocument()
    expect(screen.getByText('水酸化物の析出域')).toBeInTheDocument()
  })

  it('Mg 選択で警告（CAUTION）と代替製法の推奨が出る', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: /電極/ }))
    await user.selectOptions(screen.getByLabelText(/陽極/), 'Mg')

    expect(screen.getByText('CAUTION')).toBeInTheDocument()
    expect(screen.getByText(/ファラデーの法則が成立しません/)).toBeInTheDocument()
    // 推奨製法（酸溶解）が自動選択される
    const acidBtn = screen.getByRole('button', { name: '酸溶解' })
    expect(acidBtn).toHaveAttribute('aria-pressed', 'true')
    // 理論値は下限として表示される
    expect(screen.getByText('理論濃度（下限）')).toBeInTheDocument()
  })

  it('陰極に銅を選べ、極性反転ありなら銅が溶け出す注意が出る', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: /電極/ }))
    await user.selectOptions(screen.getByLabelText(/陰極/), '銅 Cu')
    expect(screen.getByLabelText(/陰極/)).toHaveValue('銅 Cu')
    // 初期値は陽極 Ag・極性反転 15 分ごと
    expect(screen.getByText(/銅の陰極が陽極側になって溶け出し/)).toBeInTheDocument()

    // 陽極も銅なら同じ金属なので注意は出ない
    await user.selectOptions(screen.getByLabelText(/陽極/), 'Cu')
    expect(screen.queryByText(/銅の陰極が陽極側になって溶け出し/)).not.toBeInTheDocument()

    // 極性反転なしでも出ない
    await user.selectOptions(screen.getByLabelText(/陽極/), 'Ag')
    await user.click(screen.getByRole('tab', { name: /通電/ }))
    await user.selectOptions(screen.getByLabelText('極性反転'), 'なし')
    await user.click(screen.getByRole('tab', { name: /電極/ }))
    expect(screen.queryByText(/銅の陰極が陽極側になって溶け出し/)).not.toBeInTheDocument()
  })

  it('Ca 選択では逆算が「電解不可」になる', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: /電極/ }))
    await user.selectOptions(screen.getByLabelText(/陽極/), 'Ca')
    await user.click(screen.getByRole('tab', { name: /通電/ }))
    expect(screen.getByText(/電解不可/)).toBeInTheDocument()
  })

  it('バッチを保存すると記録タブに理論値スナップショットが並ぶ', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'バッチを保存' }))
    // 保存後は記録タブへ遷移し、行が表示される
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1)
    expect(useAppStore.getState().batches).toHaveLength(1)
  })
})
