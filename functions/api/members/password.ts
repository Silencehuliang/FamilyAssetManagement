import type { AuthEnv } from '../../../src/lib/auth/service'
import { createAuthDeps, resetMemberPassword } from '../../../src/lib/auth/service'
import { requireAdmin } from '../../../src/lib/auth/session'
import { handleApi, readJsonBody, requireString } from '../../../src/lib/http'

/** POST /api/members/password —— 管理员重置任意成员密码 */
export const onRequestPost = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    await requireAdmin(request, deps.secret)
    const body = await readJsonBody(request)
    return resetMemberPassword(deps, {
      memberId: requireString(body.memberId, 'memberId'),
      newPassword: requireString(body.newPassword, 'newPassword'),
    })
  })
}
