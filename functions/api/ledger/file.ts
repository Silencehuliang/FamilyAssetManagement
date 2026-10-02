import type { AuthEnv } from '../../../src/lib/auth/service'
import { createAuthDeps } from '../../../src/lib/auth/service'
import { requireAuth } from '../../../src/lib/auth/session'
import { handleApi, optionalString, readJsonBody, requireString } from '../../../src/lib/http'
import { readLedgerFile, writeLedgerFile } from '../../../src/lib/ledger-files'

/** GET /api/ledger/file?path=ledger/... —— 已认证成员读取账本文件 */
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
    const path = new URL(request.url).searchParams.get('path')
    return readLedgerFile(deps.store, path)
  })
}

/** PUT /api/ledger/file —— 代理写入账本文件;members.json 仅限管理员 */
export const onRequestPut = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    const session = await requireAuth(request, deps.secret)
    const body = await readJsonBody(request)
    return writeLedgerFile(deps.store, session, {
      path: requireString(body.path, 'path'),
      content: requireString(body.content, 'content'),
      sha: optionalString(body.sha),
    })
  })
}
