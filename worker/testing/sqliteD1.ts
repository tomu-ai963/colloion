/**
 * テスト用: node:sqlite で D1Like を実装する。
 * D1 本体と同じく SQLite で、batch は 1 トランザクション（途中で失敗すれば全体を巻き戻す）。
 * マイグレーションは migrations/ の SQL をそのまま流す（本番と同じスキーマで試すため）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as NodeSqlite from 'node:sqlite'
import type { D1Like, D1PreparedStatementLike, D1Result } from '../db'

// vite 5 は node:sqlite を組み込みモジュールとして認識できず解決に失敗するので、require で読む
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite
type SQLInputValue = NodeSqlite.SQLInputValue

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations')

class Statement implements D1PreparedStatementLike {
  constructor(
    private owner: SqliteD1,
    private sql: string,
    private values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new Statement(this.owner, this.sql, values)
  }

  /** ?1 ?2 … は位置と番号が一致するので、そのまま位置で渡せる */
  run<T>(): D1Result<T> {
    const args = this.values.map((v) => (v === undefined ? null : (v as SQLInputValue)))
    return { results: this.owner.db.prepare(this.sql).all(...args) as T[] }
  }

  async all<T>(): Promise<D1Result<T>> {
    this.owner.queries++
    return this.run<T>()
  }
}

export class SqliteD1 implements D1Like {
  readonly db = new DatabaseSync(':memory:')
  /** 実行した文の数（D1 の「1 呼び出しあたりのクエリ数」を確かめる用） */
  queries = 0

  constructor() {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    }
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new Statement(this, sql)
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<D1Result<T>[]> {
    this.queries += statements.length
    this.db.exec('BEGIN')
    try {
      const results = statements.map((s) => (s as Statement).run<T>())
      this.db.exec('COMMIT')
      return results
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
