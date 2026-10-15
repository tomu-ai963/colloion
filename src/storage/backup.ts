/**
 * 全データの書き出し（バックアップ）と読み込み。
 *
 * IndexedDB はオリジンごとに分かれるため、配信元が変わると記録を移す手段がこれしかない。
 * 書き出すのは墓標の付いていないレコード（バッチ・試薬・母液・スポイト・通電セッション）。
 *
 * 読み込みは「上書き」ではなく同期と同じマージ規則で取り込む:
 * - この端末に無いレコードは追加
 * - ある場合は mergeRecord で決める（新しい方が勝つ。母液の使用記録は和集合、measured は拾う）
 * - この端末で削除済み（墓標）のレコードは復活させない（墓標が勝つ規則と同じ）
 * - 自端末で開いた通電セッションはこの端末が正（他端末のセッションは updatedAt の新しい方）
 * 取り込んだレコードはアプリからの保存と同じく送信待ちに積まれ、ログイン中なら同期される。
 *
 * rev はサーバーが振る番号で、別のアカウント・別のサーバーの値が紛れ込むと同期が狂うので、
 * 書き出し時も読み込み時も落とす（取り込んだ版はこの端末の既存の rev を引き継ぐ）。
 */

import { mergeLww, mergeRecord, type SyncKind, type SyncRecordMap } from '../core/merge'
import { METALS } from '../core/metals'
import type { Batch, Pipette, Reagent, Stock } from '../core/model'
import type { Session } from '../core/session'
import { deepEqual } from '../sync/equal'
import { migrateBatch, migratePipette, migrateReagent, migrateStock } from './migrate'
import type { StorageAdapter } from './StorageAdapter'

export const BACKUP_FORMAT = 'colloion-backup'
export const BACKUP_VERSION = 1

/** 端末 ID の無いセッション（手で作ったファイルなど）に入れる値。どの端末のものでもない */
export const IMPORTED_DEVICE_ID = 'imported'

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string // ISO 8601
  batches: Batch[]
  reagents: Reagent[]
  stocks: Stock[]
  pipettes: Pipette[]
  sessions: Session[]
}

export type ImportItem = { [K in SyncKind]: { kind: K; record: SyncRecordMap[K] } }[SyncKind]

export interface ImportCounts {
  /** この端末に無かったので追加した */
  added: number
  /** 既存のレコードにマージして変わった */
  updated: number
  /** 既存と同じか、既存の方が新しかった */
  unchanged: number
  /** この端末で削除済みだったので取り込まなかった */
  deletedHere: number
}

export class BackupFormatError extends Error {}

const SECTIONS: { key: keyof Pick<Backup, 'batches' | 'reagents' | 'stocks' | 'pipettes' | 'sessions'>; kind: SyncKind }[] = [
  { key: 'batches', kind: 'batch' },
  { key: 'reagents', kind: 'reagent' },
  { key: 'stocks', kind: 'stock' },
  { key: 'pipettes', kind: 'pipette' },
  { key: 'sessions', kind: 'session' },
]

const withoutRev = <T extends { rev?: number }>(r: T): T => {
  const copy = { ...r }
  delete copy.rev
  return copy
}

// ---- 書き出し ----

export async function buildBackup(store: StorageAdapter, now = new Date()): Promise<Backup> {
  const [batches, reagents, stocks, pipettes, sessions] = await Promise.all([
    store.listBatches(),
    store.listReagents(),
    store.listStocks(),
    store.listPipettes(),
    store.listSessions(),
  ])
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    batches: batches.map(withoutRev),
    reagents: reagents.map(withoutRev),
    stocks: stocks.map(withoutRev),
    pipettes: pipettes.map(withoutRev),
    sessions: sessions.map(withoutRev),
  }
}

/** 例: colloion-backup-20261015.json（端末のローカル日付） */
export function backupFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `colloion-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.json`
}

// ---- 読み込み: 形の検証 ----
// 画面が参照するフィールドが壊れていると描画で落ちるので、そこを中心に確かめる。
// 形の合わないレコードは取り込まずに数だけ数える（ファイル全体は断らない）。

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optNum = (v: unknown) => v === undefined || isNum(v)
const nums = (o: unknown, keys: string[]) => isObj(o) && keys.every((k) => isNum(o[k]))

/** 共通: id があり、墓標が付いていない（書き出しに墓標は含まれない） */
const baseOk = (v: Obj) =>
  isStr(v.id) && v.id.length > 0 && v.id.length <= 200 && v.deletedAt === undefined && optNum(v.updatedAt)

function toBatch(v: Obj, nowMs: number): Batch | null {
  const e = v.electrode
  const ok =
    baseOk(v) &&
    isStr(v.label) &&
    isStr(v.createdAt) &&
    (v.mode === 'colloid' || v.mode === 'ion') &&
    nums(v.water, ['volumeMl']) &&
    isObj(e) &&
    isStr(e.anode) &&
    Object.hasOwn(METALS, e.anode) &&
    nums(v.power, ['currentMa', 'durationSec', 'eta']) &&
    nums(v.computed, ['mg', 'ppm', 'coulombs', 'currentDensity']) &&
    Array.isArray(v.additives) &&
    v.additives.every(isObj) &&
    (v.result === undefined || isObj(v.result)) &&
    (v.measured === undefined ||
      (nums(v.measured, ['coulombs', 'mg', 'ppm', 'etaPct']) && isStr((v.measured as Obj).sessionId)))
  return ok ? migrateBatch(v as unknown as Batch, nowMs) : null
}

function toReagent(v: Obj, nowMs: number): Reagent | null {
  const ok = baseOk(v) && isStr(v.name) && isStr(v.formula) && isNum(v.mw)
  return ok ? migrateReagent(v as unknown as Reagent, nowMs) : null
}

function toStock(v: Obj, nowMs: number): Stock | null {
  const usagesOk =
    v.usages === undefined ||
    (Array.isArray(v.usages) &&
      v.usages.every((u) => isObj(u) && isStr(u.id) && isNum(u.at) && isNum(u.doseMl)))
  const ok =
    baseOk(v) &&
    isStr(v.reagentId) &&
    isNum(v.molarity) &&
    isStr(v.preparedAt) &&
    usagesOk &&
    optNum(v.initialVolumeMl) &&
    optNum(v.volumeRemainingMl)
  return ok ? migrateStock(v as never, nowMs) : null
}

function toPipette(v: Obj, nowMs: number): Pipette | null {
  const ok = baseOk(v) && isStr(v.name) && isNum(v.mlPer20Drops)
  return ok ? migratePipette(v as unknown as Pipette, nowMs) : null
}

const SESSION_STATUS = new Set(['running', 'paused', 'completed', 'aborted'])

function toSession(v: Obj): Session | null {
  const ok =
    baseOk(v) &&
    isStr(v.batchId) &&
    isNum(v.startedAt) &&
    isStr(v.status) &&
    SESSION_STATUS.has(v.status) &&
    Array.isArray(v.segments) &&
    v.segments.every((s) => nums(s, ['index', 'startedAt', 'currentMa', 'coulombs'])) &&
    Array.isArray(v.marks) &&
    v.marks.every((m) => isObj(m) && isNum(m.at)) &&
    isNum(v.totalCoulombs) &&
    isNum(v.pausedDurationMs) &&
    (v.deviceId === undefined || isStr(v.deviceId))
  if (!ok) return null
  const s = v as unknown as Session
  return {
    ...s,
    deviceId: s.deviceId ?? IMPORTED_DEVICE_ID,
    updatedAt: s.updatedAt ?? s.endedAt ?? s.startedAt,
  }
}

function normalize(kind: SyncKind, raw: unknown, nowMs: number): ImportItem | null {
  if (!isObj(raw)) return null
  const v = withoutRev(raw as Obj & { rev?: number })
  switch (kind) {
    case 'batch': {
      const record = toBatch(v, nowMs)
      return record && { kind, record }
    }
    case 'reagent': {
      const record = toReagent(v, nowMs)
      return record && { kind, record }
    }
    case 'stock': {
      const record = toStock(v, nowMs)
      return record && { kind, record }
    }
    case 'pipette': {
      const record = toPipette(v, nowMs)
      return record && { kind, record }
    }
    case 'session': {
      const record = toSession(v)
      return record && { kind, record }
    }
  }
}

export interface ParsedBackup {
  items: ImportItem[]
  /** 形が合わず取り込めないレコードの数 */
  invalid: number
}

/**
 * ファイルの中身を読み、取り込むレコードの一覧にする。
 * 受け付けるのは全データのバックアップと、記録タブの「バッチを JSON で書き出す」（バッチの配列）。
 * ファイル全体として読めないときは BackupFormatError（画面にそのまま出す文言）。
 */
export function parseBackup(text: string, nowMs = Date.now()): ParsedBackup {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new BackupFormatError('JSON として読めませんでした。')
  }

  let sections: { kind: SyncKind; list: unknown }[]
  if (Array.isArray(data)) {
    sections = [{ kind: 'batch', list: data }]
  } else if (isObj(data) && data.format === BACKUP_FORMAT) {
    if (!isNum(data.version) || data.version > BACKUP_VERSION) {
      throw new BackupFormatError('このファイルは新しい版の colloion で書き出されたため読み込めません。')
    }
    sections = SECTIONS.map(({ key, kind }) => ({ kind, list: data[key] ?? [] }))
  } else {
    throw new BackupFormatError('colloion のバックアップではありません。')
  }

  // 同じレコードが複数あれば updatedAt の新しい方
  const byKey = new Map<string, ImportItem>()
  let invalid = 0
  for (const { kind, list } of sections) {
    if (!Array.isArray(list)) throw new BackupFormatError('colloion のバックアップではありません。')
    for (const raw of list) {
      const item = normalize(kind, raw, nowMs)
      if (!item) {
        invalid++
        continue
      }
      const key = `${kind}:${item.record.id}`
      const prev = byKey.get(key)
      if (!prev || item.record.updatedAt > prev.record.updatedAt) byKey.set(key, item)
    }
  }
  return { items: [...byKey.values()], invalid }
}

// ---- 読み込み: 既存レコードとの突き合わせ ----

export type ImportOutcome = keyof ImportCounts

/**
 * 取り込む版（incoming。rev・墓標は無い）を既存のレコードと突き合わせる。純関数。
 * next があればそれを書いて送信待ちに積む。
 */
export function resolveImport<K extends SyncKind>(
  kind: K,
  existing: SyncRecordMap[K] | undefined,
  incoming: SyncRecordMap[K],
  selfDeviceId: string,
): { outcome: ImportOutcome; next?: SyncRecordMap[K] } {
  if (!existing) return { outcome: 'added', next: incoming }
  if (existing.deletedAt !== undefined) return { outcome: 'deletedHere' }

  let merged: SyncRecordMap[K]
  if (kind === 'session') {
    // 同期のマージは「他端末のセッションはサーバーが正」だが、古いバックアップが
    // 新しい版を上書きしないよう、取り込みでは自端末のもの以外も新しい方を残す
    const ex = existing as Session
    merged = (ex.deviceId === selfDeviceId ? ex : mergeLww(ex, incoming as Session)) as SyncRecordMap[K]
  } else {
    merged = mergeRecord(kind, existing, incoming, selfDeviceId)
  }
  if (deepEqual(merged, existing)) return { outcome: 'unchanged' }
  return { outcome: 'updated', next: merged }
}

export const emptyCounts = (): ImportCounts => ({ added: 0, updated: 0, unchanged: 0, deletedHere: 0 })
