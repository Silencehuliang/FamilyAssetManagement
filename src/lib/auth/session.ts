/**
 * 会话中间件助手:从 Authorization: Bearer <jwt> 读取并校验会话,
 * 提供 admin-only 操作的角色门禁(ADR-0002 的权限矩阵在服务端强制执行)。
 */
import { HttpError } from '../http'
import type { JwtPayload } from './jwt'
import { signJwt, verifyJwt } from './jwt'

/** 会话有效期:7 天 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

export interface SessionMember {
  id: string
  role: 'admin' | 'member'
  displayName: string
}

/** 为成员签发会话 JWT */
export async function createSession(
  member: SessionMember,
  secret: string,
  now = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return signJwt(
    {
      sub: member.id,
      role: member.role,
      name: member.displayName,
      iat,
      exp: iat + SESSION_TTL_SECONDS,
    },
    secret,
  )
}

/** 校验请求携带的 Bearer 会话;缺失/无效/过期抛 401 */
export async function requireAuth(request: Request, secret: string): Promise<JwtPayload> {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'unauthorized', '缺少会话凭据')
  }
  const payload = await verifyJwt(header.slice('Bearer '.length), secret)
  if (!payload) {
    throw new HttpError(401, 'unauthorized', '会话无效或已过期')
  }
  return payload
}

/** 校验会话且必须是管理员;未认证 401,非管理员 403 */
export async function requireAdmin(request: Request, secret: string): Promise<JwtPayload> {
  const payload = await requireAuth(request, secret)
  if (payload.role !== 'admin') {
    throw new HttpError(403, 'forbidden', '仅管理员可执行此操作')
  }
  return payload
}
