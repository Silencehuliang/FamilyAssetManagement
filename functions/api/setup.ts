import type { AuthEnv } from '../../src/lib/auth/service'
import { createAuthDeps, initialize } from '../../src/lib/auth/service'
import { handleApi, readJsonBody, requireString } from '../../src/lib/http'

/** POST /api/setup —— 一次性初始化:创建管理员,仅当仓库无 members.json 时可用 */
export const onRequestPost = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    const body = await readJsonBody(request)
    return initialize(deps, {
      username: requireString(body.username, 'username'),
      displayName: requireString(body.displayName, 'displayName'),
      password: requireString(body.password, 'password'),
    })
  })
}
