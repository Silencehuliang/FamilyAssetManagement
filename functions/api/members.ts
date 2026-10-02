import type { AuthEnv } from '../../src/lib/auth/service'
import { createAuthDeps, listMembers } from '../../src/lib/auth/service'
import { requireAuth } from '../../src/lib/auth/session'
import { handleApi } from '../../src/lib/http'

/** GET /api/members —— 已认证成员获取成员列表(去凭据,凭据永不过代理) */
export const onRequestGet = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    await requireAuth(request, deps.secret)
    return { members: await listMembers(deps) }
  })
}
