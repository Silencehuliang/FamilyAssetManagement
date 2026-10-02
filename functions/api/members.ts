import type { AuthEnv } from '../../src/lib/auth/service'
import { createAuthDeps, isInitialized, listMembers } from '../../src/lib/auth/service'
import { requireAuth } from '../../src/lib/auth/session'
import { HttpError, handleApi } from '../../src/lib/http'

/**
 * GET /api/members —— 已认证成员获取成员列表(去凭据,凭据永不过代理)。
 * 未携带会话时区分两种状态供客户端选择入口:
 * - 仓库无 members.json → 500 members_file_missing(部署尚未初始化 → 初始化向导)
 * - 已有 members.json → 401 unauthorized(已初始化 → 登录页)
 * 该探测只泄露「是否已初始化」,与 POST /api/setup 的一次性保护所泄露的信息相同。
 */
export const onRequestGet = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    if (!request.headers.get('authorization')) {
      if (!(await isInitialized(deps))) {
        throw new HttpError(500, 'members_file_missing', '账本尚未初始化')
      }
      throw new HttpError(401, 'unauthorized', '缺少会话凭据')
    }
    await requireAuth(request, deps.secret)
    return { members: await listMembers(deps) }
  })
}
