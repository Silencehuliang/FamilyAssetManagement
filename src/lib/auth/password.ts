/**
 * PBKDF2-SHA256 口令哈希(ADR-0005)。
 * 存储格式:pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>,盐 ≥16 字节,迭代数 ≥100_000。
 * 仅依赖 crypto.subtle,可在 Node 与 Workers 中运行。
 */
export const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const HASH_BITS = 256

export interface PasswordCredential {
  passwordHash: string
  passwordSalt: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    HASH_BITS,
  )
  return new Uint8Array(bits)
}

/** 生成凭据;每次调用使用随机盐 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<PasswordCredential> {
  if (iterations < PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be >= ${PBKDF2_ITERATIONS}`)
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await deriveBits(password, salt, iterations)
  return {
    passwordHash: `pbkdf2$sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`,
    passwordSalt: bytesToBase64(salt),
  }
}

/** 校验口令与存储的哈希是否匹配;格式非法一律返回 false */
export async function verifyPassword(
  password: string,
  credential: Pick<PasswordCredential, 'passwordHash'>,
): Promise<boolean> {
  const parts = credential.passwordHash.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') {
    return false
  }
  const [, , iterationsText, saltBase64, hashBase64] = parts
  if (!iterationsText || !saltBase64 || !hashBase64) {
    return false
  }
  const iterations = Number.parseInt(iterationsText, 10)
  if (!Number.isInteger(iterations) || iterations < PBKDF2_ITERATIONS) {
    return false
  }
  try {
    const expected = base64ToBytes(hashBase64)
    const actual = await deriveBits(password, base64ToBytes(saltBase64), iterations)
    if (actual.length !== expected.length) {
      return false
    }
    let diff = 0
    for (let i = 0; i < actual.length; i++) {
      diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0)
    }
    return diff === 0
  } catch {
    return false
  }
}
