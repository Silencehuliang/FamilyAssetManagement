import { describe, expect, it } from 'vitest'
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from './password'

const ADR_HASH_FORMAT = /^pbkdf2\$sha256\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/

function base64Length(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

describe('hashPassword / verifyPassword', () => {
  it('正确口令校验通过', async () => {
    const credential = await hashPassword('correct horse battery')
    await expect(verifyPassword('correct horse battery', credential)).resolves.toBe(true)
  })

  it('错误口令校验失败', async () => {
    const credential = await hashPassword('correct horse battery')
    await expect(verifyPassword('wrong password', credential)).resolves.toBe(false)
  })

  it('哈希字符串符合 ADR-0005 格式:盐 ≥16 字节、迭代数 ≥100_000、哈希 32 字节', async () => {
    const { passwordHash, passwordSalt } = await hashPassword('s3cret-密码')
    const match = ADR_HASH_FORMAT.exec(passwordHash)
    expect(match).not.toBeNull()
    expect(passwordSalt).toBeTypeOf('string')
    if (!match) return
    const iterations = Number.parseInt(match[1] ?? '0', 10)
    expect(iterations).toBeGreaterThanOrEqual(100_000)
    expect(iterations).toBe(PBKDF2_ITERATIONS)
    expect(base64Length(match[2] ?? '')).toBeGreaterThanOrEqual(16)
    expect(base64Length(match[3] ?? '')).toBe(32)
  })

  it('相同口令两次哈希得到不同盐与不同哈希', async () => {
    const first = await hashPassword('same-password')
    const second = await hashPassword('same-password')
    expect(first.passwordSalt).not.toBe(second.passwordSalt)
    expect(first.passwordHash).not.toBe(second.passwordHash)
    await expect(verifyPassword('same-password', second)).resolves.toBe(true)
  })

  it('存储哈希格式损坏时校验返回 false 而不是抛错', async () => {
    await expect(verifyPassword('x', { passwordHash: 'garbage' })).resolves.toBe(false)
    await expect(verifyPassword('x', { passwordHash: 'md5$abc$def' })).resolves.toBe(false)
    await expect(verifyPassword('x', { passwordHash: 'pbkdf2$sha256$abc$!!!$???' })).resolves.toBe(
      false,
    )
  })

  it('拒绝以低于 100_000 的迭代数生成哈希', async () => {
    await expect(hashPassword('weak', 1000)).rejects.toThrow(/iterations/)
  })
})
