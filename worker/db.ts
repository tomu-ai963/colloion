/**
 * Worker が使う D1 の最小限の型。
 * @cloudflare/workers-types に頼らず必要な部分だけを書くことで、
 * テストでは node:sqlite による実装（worker/testing/sqliteD1.ts）を同じ型で差し込める。
 */

export interface D1Result<T> {
  results: T[]
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike
  /** 文をまとめて 1 トランザクションで実行する（途中で失敗すれば全体が巻き戻る） */
  batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1Result<T>[]>
}
