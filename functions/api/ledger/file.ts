import type { AuthEnv } from '../../../src/lib/auth/service'
import { createAuthDeps, requireActiveAuth } from '../../../src/lib/auth/service'
import {
  handleApi,
  optionalString,
  readJsonBody,
  requireRawString,
  requireString,
} from '../../../src/lib/http'
import { deleteLedgerFile, readLedgerFile, writeLedgerFile } from '../../../src/lib/ledger-files'

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
    await requireActiveAuth(request, deps)
    const path = new URL(request.url).searchParams.get('path')
    return readLedgerFile(deps.store, path)
  })
}

/** PUT /api/ledger/file —— 代理写入账本文件;members.json 双向拒绝 */
export const onRequestPut = ({
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
    return writeLedgerFile(deps.store, session, {
      path: requireString(body.path, 'path'),
      // 内容不 trim:账本 JSON 以 \n 结尾,原样写入才能保证同步幂等(git diff 友好)
      content: requireRawString(body.content, 'content'),
      sha: optionalString(body.sha),
    })
  })
}

/** DELETE /api/ledger/file —— 删除支出月份文件(需携带当前 sha);其余路径 403 */
export const onRequestDelete = ({
  request,
  env,
}: {
  request: Request
  env: AuthEnv
}): Promise<Response> => {
  return handleApi(async () => {
    const deps = createAuthDeps(env)
    await requireActiveAuth(request, deps)
    const body = await readJsonBody(request)
    return deleteLedgerFile(deps.store, {
      path: requireString(body.path, 'path'),
      sha: requireString(body.sha, 'sha'),
    })
  })
}
