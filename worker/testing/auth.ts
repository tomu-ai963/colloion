/**
 * テスト用: Neon Auth の代わりに手元で Ed25519 の鍵を作り、同じ形の JWT を発行する。
 * 本番の検証コード（worker/auth.ts の authenticate）をそのまま通すため、鍵の出どころだけ差し替える。
 */

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import type { AuthConfig } from '../auth'

export const TEST_ISSUER = 'https://ep-test.aws.neon.tech'

export interface TestAuth {
  config: AuthConfig
  token(sub: string, opts?: { expiresIn?: string; issuer?: string; audience?: string; banned?: boolean }): Promise<string>
  /** 別の鍵で署名したトークン（署名不一致の確認用） */
  forgedToken(sub: string): Promise<string>
}

async function signer(privateKey: CryptoKey, kid: string) {
  return (sub: string, opts: Parameters<TestAuth['token']>[1] = {}) =>
    new SignJWT({ role: 'authenticated', banned: opts.banned ?? false })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject(sub)
      .setIssuedAt()
      .setIssuer(opts.issuer ?? TEST_ISSUER)
      .setAudience(opts.audience ?? TEST_ISSUER)
      .setExpirationTime(opts.expiresIn ?? '15m')
      .sign(privateKey)
}

export async function createTestAuth(): Promise<TestAuth> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'EdDSA' }
  const forged = await generateKeyPair('EdDSA')
  return {
    config: {
      issuer: TEST_ISSUER,
      audience: TEST_ISSUER,
      keys: async (header) => {
        if (header.kid !== jwk.kid) throw new Error('no matching key')
        return publicKey
      },
    },
    token: await signer(privateKey, jwk.kid),
    forgedToken: (sub) => signer(forged.privateKey, jwk.kid).then((sign) => sign(sub)),
  }
}
