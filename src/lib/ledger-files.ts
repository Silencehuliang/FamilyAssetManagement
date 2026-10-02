/**
 * 账本文件读写代理(ADR-0002/0004/0005):
 * - 路径必须位于 ledger/ 之下,越界一律 400;
 * - 读取对所有已认证成员开放;
 * - 写入 members.json 仅限管理员(成员即账户的凭据不得被普通成员改写)。
 */
import type { JwtPayload } from './auth/jwt'
import { MEMBERS_FILE } from './auth/members'
import type { LedgerStore } from './github'
import { HttpError } from './http'

export function validateLedgerPath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('ledger/') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('//')
  ) {
    throw new HttpError(400, 'invalid_path', '路径必须位于 ledger/ 目录内')
  }
  return path
}

export async function readLedgerFile(
  store: LedgerStore,
  path: unknown,
): Promise<{ content: string; sha: string }> {
  const file = await store.getFile(validateLedgerPath(path))
  if (!file) {
    throw new HttpError(404, 'not_found', '账本文件不存在')
  }
  return file
}

export interface WriteLedgerInput {
  path: string
  content: string
  sha?: string
}

export async function writeLedgerFile(
  store: LedgerStore,
  session: JwtPayload,
  input: WriteLedgerInput,
): Promise<{ sha: string }> {
  const path = validateLedgerPath(input.path)
  if (path === MEMBERS_FILE && session.role !== 'admin') {
    throw new HttpError(403, 'forbidden', '仅管理员可修改成员数据')
  }
  return { sha: await store.putFile(path, input.content, input.sha) }
}
