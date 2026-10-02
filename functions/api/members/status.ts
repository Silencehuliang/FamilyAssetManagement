import type { AuthEnv } from '../../../src/lib/auth/service'
import { createAuthDeps, requireActiveAdmin, setMemberStatus } from '../../../src/lib/auth/service'
import { HttpError, handleApi, readJsonBody, requireString } from '../../../src/lib/http'

/**
 * POST /api/members/status —— 管理员启用/停用成员(T9):{memberId, disabled}。
 * 停用后该成员的旧会话在下一次请求即被拒(requireActiveAuth 校验 disabled 标志);
 * 不允许停用自己(400 cannot_disable_self)。
 */
export const onRequestPost = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    const session = await requireActiveAdmin(request, deps)
    const body = await readJsonBody(request)
    if (typeof body.disabled !== 'boolean') {
      throw new HttpError(400, 'invalid_request', 'disabled 必须是布尔值')
    }
    return setMemberStatus(deps, session.sub, {
      memberId: requireString(body.memberId, 'memberId'),
      disabled: body.disabled,
    })
  })
}
