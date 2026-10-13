/**
 * 認証: Neon Managed Better Auth が発行する JWT（EdDSA / 有効期限 15 分）を検証する。
 * 公開鍵は `<NEON_AUTH_BASE_URL>/.well-known/jwks.json` から取る。秘密情報は持たない。
 * iss / aud は auth URL のオリジン（Neon のドキュメントの検証例どおり）。
 */

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'

export class Unauthorized extends Error {
  constructor(message = '認証が必要です') {
    super(message)
    this.name = 'Unauthorized'
  }
}

/**
 * 認証基盤（JWKS）に届かない。トークンが悪いのではないので 401 にしない
 * （401 だとクライアントは同期を止めてしまう。503 なら再試行する）
 */
export class AuthUnavailable extends Error {
  constructor() {
    super('認証基盤に接続できません')
    this.name = 'AuthUnavailable'
  }
}

/** JWKS の取得失敗か（タイムアウト・通信失敗・200 以外の応答） */
const isJwksFetchFailure = (e: unknown): boolean =>
  e instanceof errors.JWKSTimeout ||
  e instanceof TypeError ||
  (e instanceof errors.JOSEError && e.code === 'ERR_JOSE_GENERIC')

export interface AuthConfig {
  issuer: string
  audience: string
  keys: JWTVerifyGetKey
}

// JWKS はアイソレート内で使い回す（jose がキャッシュと鍵の入れ替えに対応している）
const jwksCache = new Map<string, JWTVerifyGetKey>()

/** NEON_AUTH_BASE_URL から検証設定を作る。https 以外は受け付けない */
export function authConfigFromBaseUrl(baseUrl: string): AuthConfig {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:') throw new Error('NEON_AUTH_BASE_URL は https である必要があります')
  const jwksUrl = `${baseUrl.replace(/\/+$/, '')}/.well-known/jwks.json`
  let keys = jwksCache.get(jwksUrl)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl))
    jwksCache.set(jwksUrl, keys)
  }
  return { issuer: url.origin, audience: url.origin, keys }
}

/** Authorization: Bearer <JWT> を検証してユーザー ID（sub）を返す */
export async function authenticate(request: Request, config: AuthConfig): Promise<string> {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header)
  if (!match) throw new Unauthorized()
  try {
    const { payload } = await jwtVerify(match[1]!, config.keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'exp'],
    })
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new Unauthorized()
    if (payload.banned === true) throw new Unauthorized('このアカウントは利用できません')
    return payload.sub
  } catch (e) {
    if (e instanceof Unauthorized) throw e
    if (isJwksFetchFailure(e)) throw new AuthUnavailable()
    // 署名不一致・期限切れ・クレーム不一致などは理由を返さない
    throw new Unauthorized()
  }
}
