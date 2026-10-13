/**
 * 同期を使えるユーザーの許可リスト（SYNC_ALLOWED_USER_IDS）。
 *
 * Neon Auth のサインアップは誰にでも開いている（コードでもパスワードでも作れる）。
 * 許可リストが無いと、誰でもアカウントを作って同期 API を叩き、D1 の日次上限
 * （アカウント全体で共有。同じアカウントの他の Worker も止まる）や容量を使い切れる。
 *
 * - 未設定・空: 同期 API を止める（503）。設定漏れで全開放にならないよう、安全側に倒す
 * - `*`: 全員に許可（ユーザーごとの容量上限が無い今は使わないこと）
 * - それ以外: カンマ区切りのユーザー ID（JWT の sub = Neon の user.id）
 *
 * メールアドレスではなく ID で判定する。メールで判定すると、他人のアドレスで
 * 先に登録されたアカウント（Neon 側でメール確認なしにパスワード登録できる）を通してしまう。
 */

export type AccessPolicy = { kind: 'all' } | { kind: 'list'; ids: ReadonlySet<string> }

/** 設定値を読む。未設定・空なら null（＝同期を止める） */
export function parseAllowedUsers(raw: string | undefined): AccessPolicy | null {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (entries.length === 0) return null
  if (entries.includes('*')) return { kind: 'all' }
  return { kind: 'list', ids: new Set(entries) }
}

export const isAllowed = (policy: AccessPolicy, userId: string): boolean =>
  policy.kind === 'all' || policy.ids.has(userId)
