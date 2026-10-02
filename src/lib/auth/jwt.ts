/**
 * JWT HS256 签发与校验(ADR-0002:服务端签发会话,客户端持有 JWT)。
 * 载荷:{sub: 成员 id, role, name, iat, exp}。校验同时核对签名、算法与过期时间。
 */
import type { Role } from '../../domain/types'

export interface JwtPayload {
  sub: string
  role: Role
  name: string
  iat: number
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)))
}

async function importHmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const unsigned = `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}`
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importHmacKey(secret, ['sign']),
    encoder.encode(unsigned),
  )
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/** 校验签名与过期时间;任何失败返回 null。now 可注入以便测试过期行为 */
export async function verifyJwt(
  token: string,
  secret: string,
  now: () => number = Date.now,
): Promise<JwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  const [headerPart, payloadPart, signaturePart] = parts
  if (!headerPart || !payloadPart || !signaturePart) {
    return null
  }
  try {
    const header = JSON.parse(decoder.decode(base64UrlToBytes(headerPart))) as { alg?: unknown }
    if (header.alg !== 'HS256') {
      return null
    }
    const signature = base64UrlToBytes(signaturePart)
    const valid = await crypto.subtle.verify(
      'HMAC',
      await importHmacKey(secret, ['verify']),
      signature as BufferSource,
      encoder.encode(`${headerPart}.${payloadPart}`),
    )
    if (!valid) {
      return null
    }
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadPart))) as Partial<JwtPayload>
    if (!isPayload(payload) || typeof payload.exp !== 'number' || payload.exp * 1000 <= now()) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

function isPayload(payload: Partial<JwtPayload>): payload is JwtPayload {
  return (
    typeof payload.sub === 'string' &&
    (payload.role === 'admin' || payload.role === 'member') &&
    typeof payload.name === 'string' &&
    typeof payload.iat === 'number'
  )
}
