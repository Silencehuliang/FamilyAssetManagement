import { describe, expect, it } from 'vitest'
import { type JwtPayload, signJwt, verifyJwt } from './jwt'
import { createSession, SESSION_TTL_SECONDS } from './session'

const SECRET = 'test-signing-secret'
const PAYLOAD: JwtPayload = {
  sub: 'member-1',
  role: 'member',
  name: '小红',
  iat: 1_900_000_000,
  exp: 1_900_000_000 + 3600,
}

/** 与 jwt.ts 一致的 base64url 编码(先按 UTF-8 取字节,避免 btoa 的 Latin-1 限制) */
function base64UrlEncode(value: object): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

describe('signJwt / verifyJwt', () => {
  it('签发后校验通过,载荷字段一致', async () => {
    const token = await signJwt(PAYLOAD, SECRET)
    await expect(verifyJwt(token, SECRET)).resolves.toEqual(PAYLOAD)
  })

  it('过期令牌被拒绝', async () => {
    const token = await signJwt({ ...PAYLOAD, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET)
    await expect(verifyJwt(token, SECRET)).resolves.toBeNull()
  })

  it('篡改载荷被拒绝', async () => {
    const token = await signJwt(PAYLOAD, SECRET)
    const [header, , signature] = token.split('.')
    const forgedPayload = base64UrlEncode({ ...PAYLOAD, role: 'admin' })
    await expect(verifyJwt(`${header}.${forgedPayload}.${signature}`, SECRET)).resolves.toBeNull()
  })

  it('密钥不符被拒绝', async () => {
    const token = await signJwt(PAYLOAD, SECRET)
    await expect(verifyJwt(token, 'another-secret')).resolves.toBeNull()
  })

  it('非法字符串被拒绝', async () => {
    await expect(verifyJwt('not-a-jwt', SECRET)).resolves.toBeNull()
    await expect(verifyJwt('a.b', SECRET)).resolves.toBeNull()
    await expect(verifyJwt('!!!.???.@@@', SECRET)).resolves.toBeNull()
  })

  it('声明其他算法的令牌即使签名有效也被拒绝', async () => {
    const unsigned = `${base64UrlEncode({ alg: 'none', typ: 'JWT' })}.${base64UrlEncode(PAYLOAD)}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned))
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    await expect(verifyJwt(`${unsigned}.${signatureBase64}`, SECRET)).resolves.toBeNull()
  })
})

describe('createSession', () => {
  it('按成员身份签发会话,有效期 7 天', async () => {
    const now = new Date('2026-10-02T08:00:00Z')
    const token = await createSession(
      { id: 'member-9', role: 'admin', displayName: '管理员' },
      SECRET,
      now,
    )
    const payload = await verifyJwt(token, SECRET)
    expect(payload).toMatchObject({
      sub: 'member-9',
      role: 'admin',
      name: '管理员',
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
    })
  })
})

describe('verifyJwt 可注入时钟', () => {
  it('注入过期后的时钟返回 null,注入未过期的时钟返回载荷', async () => {
    const iat = 1_700_000_000
    const exp = iat + 60
    const token = await signJwt({ sub: 'm-1', role: 'member', name: '测试', iat, exp }, SECRET)
    expect(await verifyJwt(token, SECRET, () => (exp - 1) * 1000)).toMatchObject({ sub: 'm-1' })
    expect(await verifyJwt(token, SECRET, () => (exp + 1) * 1000)).toBeNull()
  })
})
