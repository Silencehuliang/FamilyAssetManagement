import type { AuthEnv } from '../../../src/lib/auth/service'
import { changeOwnPassword, createAuthDeps, requireActiveAuth } from '../../../src/lib/auth/service'
import { handleApi, readJsonBody, requireString } from '../../../src/lib/http'

/** POST /api/auth/password —— 已认证成员修改自己的密码 */
export const onRequestPost = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    const session = await requireActiveAuth(request, deps)
    const body = await readJsonBody(request)
    return changeOwnPassword(deps, session.sub, {
      currentPassword: requireString(body.currentPassword, 'currentPassword'),
      newPassword: requireString(body.newPassword, 'newPassword'),
    })
  })
}
