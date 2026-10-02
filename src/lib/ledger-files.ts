/**
 * 账本文件读写代理(ADR-0002/0004/0005):
 * - 路径必须位于 ledger/ 之下,越界一律 400;
 * - 读取对所有已认证成员开放;
 * - 写入仅限:支出月度文件与周期规则(所有成员)、分类/预算/成员元数据(仅管理员)。
 */
import type { JwtPayload } from './auth/jwt'
import { MEMBERS_FILE, parseMembers } from './auth/members'
import type { LedgerStore } from './github'
import { HttpError } from './http'

const ADMIN_ONLY_FILES = new Set([
  MEMBERS_FILE,
  'ledger/meta/categories.json',
  'ledger/meta/budgets.json',
])

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
  if (ADMIN_ONLY_FILES.has(path) && session.role !== 'admin') {
    throw new HttpError(403, 'forbidden', '仅管理员可修改该元数据')
  }
  if (path === MEMBERS_FILE) {
    try {
      parseMembers(input.content)
    } catch {
      throw new HttpError(400, 'invalid_members', 'members.json 内容不合法,拒绝写入')
    }
  }
  return { sha: await store.putFile(path, input.content, input.sha) }
}
