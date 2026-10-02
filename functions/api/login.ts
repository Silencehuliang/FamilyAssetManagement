import type { AuthEnv } from '../../src/lib/auth/service'
import { createAuthDeps, login } from '../../src/lib/auth/service'
import { handleApi, readJsonBody, requireString } from '../../src/lib/http'

/** POST /api/login —— 校验凭据并签发会话 JWT */
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
    return login(deps, {
      username: requireString(body.username, 'username'),
      password: requireString(body.password, 'password'),
    })
  })
}
