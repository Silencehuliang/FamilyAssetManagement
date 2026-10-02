import type { AuthEnv } from '../../../src/lib/auth/service'
import { createAuthDeps } from '../../../src/lib/auth/service'
import { requireAuth } from '../../../src/lib/auth/session'
import { handleApi } from '../../../src/lib/http'
import { listLedgerFiles } from '../../../src/lib/ledger-files'

/** GET /api/ledger/list —— 已认证成员列出同步范围的账本文件(内容 + 修订号) */
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
    return { files: await listLedgerFiles(deps.store) }
  })
}
