/**
 * 账本文件读写代理(ADR-0002/0004/0005/0006):
 * - 路径必须位于 ledger/ 之下,越界一律 400;
 * - 读取对所有已认证成员开放,但 members.json 除外 —— 凭据永不过代理,
 *   客户端经 GET /api/members 获取去凭据的成员列表;
 * - 写入仅限:支出月度文件、周期规则与标签实体(所有成员)、分类/预算/标签组元数据(仅管理员);
 * - members.json 双向皆由鉴权端点专属管理,代理一律 403;
 * - 删除仅限支出月份文件(最后一条支出被删、月份文件应消失),需携带当前 sha;
 * - 列表接口返回客户端同步范围的全部文件(月份 + 五个 meta;members.json 永不包含)。
 */
import {
  BUDGETS_FILE,
  CATEGORIES_FILE,
  parseMonthFilePath,
  RECURRING_FILE,
  TAG_GROUPS_FILE,
  TAGS_FILE,
} from '../sync/files'
import type { JwtPayload } from './auth/jwt'
import { MEMBERS_FILE } from './auth/members'
import type { LedgerStore } from './github'
import { HttpError } from './http'

/** 管理员专属元数据:分类/预算/标签组(标签实体全员可写,ADR-0006) */
const ADMIN_ONLY_FILES = new Set([CATEGORIES_FILE, BUDGETS_FILE, TAG_GROUPS_FILE])

/** 同步范围内的单文件快照(客户端 remote 适配器映射为 RemoteFile) */
export interface LedgerFileSnapshot {
  content: string
  revision: string
}

const MONTHS_DIR = 'ledger/months'

/**
 * 列出同步范围的账本文件:先列出 months/ 目录再逐个取内容,
 * 加上五个 meta 文件;不存在或不是月文件命名的条目直接省略。
 * members.json 永不进入结果(客户端同步文件集不含成员凭据文件)。
 */
export async function listLedgerFiles(
  store: LedgerStore,
): Promise<Record<string, LedgerFileSnapshot>> {
  const files: Record<string, LedgerFileSnapshot> = {}
  const entries = await store.listDirectory(MONTHS_DIR)
  for (const entry of entries) {
    if (entry.type !== 'file' || !parseMonthFilePath(entry.path)) continue
    const file = await store.getFile(entry.path)
    if (file) files[entry.path] = { content: file.content, revision: file.sha }
  }
  for (const path of [CATEGORIES_FILE, TAGS_FILE, TAG_GROUPS_FILE, BUDGETS_FILE, RECURRING_FILE]) {
    const file = await store.getFile(path)
    if (file) files[path] = { content: file.content, revision: file.sha }
  }
  return files
}

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
  const validPath = validateLedgerPath(path)
  if (validPath === MEMBERS_FILE) {
    throw new HttpError(403, 'members_not_readable', '成员凭据文件不可读取,请使用 GET /api/members')
  }
  const file = await store.getFile(validPath)
  if (!file) {
    throw new HttpError(404, 'not_found', '账本文件不存在')
  }
  return file
}

export interface DeleteLedgerInput {
  path: string
  /** 删除目标的当前 blob sha(乐观并发) */
  sha: string
}

/** 删除月份文件(仅 ledger/months/*.json);其他路径一律 403 */
export async function deleteLedgerFile(
  store: LedgerStore,
  input: DeleteLedgerInput,
): Promise<{ deleted: true }> {
  const path = validateLedgerPath(input.path)
  if (!parseMonthFilePath(path)) {
    throw new HttpError(403, 'not_deletable', '仅可删除支出月份文件')
  }
  await store.deleteFile(path, input.sha)
  return { deleted: true }
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
  if (path === MEMBERS_FILE) {
    throw new HttpError(403, 'members_server_owned', 'members.json 由鉴权端点专属管理')
  }
  if (ADMIN_ONLY_FILES.has(path) && session.role !== 'admin') {
    throw new HttpError(403, 'forbidden', '仅管理员可修改该元数据')
  }
  return { sha: await store.putFile(path, input.content, input.sha) }
}
