/**
 * 成员即账户(CONTEXT):领域类型 Member 不含凭据,
 * 存储层以 MemberRecord = Member & { passwordHash, passwordSalt } 表示(ADR-0005)。
 * members.json 结构:{"members": [...]},2 空格缩进、结尾换行。
 */
import type { Member } from '../../domain/types'
import { HttpError } from '../http'
import type { PasswordCredential } from './password'

export const MEMBERS_FILE = 'ledger/meta/members.json'

export type MemberRecord = Member & PasswordCredential

export interface MembersFile {
  members: MemberRecord[]
}

/** 公开给客户端的成员视图(剥离凭据) */
export function toPublicMember(record: MemberRecord): Member {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    disabled: record.disabled,
    createdAt: record.createdAt,
  }
}

export function serializeMembers(records: MemberRecord[]): string {
  const file: MembersFile = { members: records }
  return `${JSON.stringify(file, null, 2)}\n`
}

function isMemberRecord(value: unknown): value is MemberRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const m = value as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.username === 'string' &&
    typeof m.displayName === 'string' &&
    (m.role === 'admin' || m.role === 'member') &&
    typeof m.disabled === 'boolean' &&
    typeof m.createdAt === 'string' &&
    typeof m.passwordHash === 'string' &&
    typeof m.passwordSalt === 'string'
  )
}

/** 解析 members.json;仓库文件被人为破坏时返回 500 */
export function parseMembers(text: string): MemberRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(500, 'members_file_corrupt', 'members.json 不是合法 JSON')
  }
  const members = (parsed as Partial<MembersFile> | null)?.members
  if (!Array.isArray(members) || !members.every(isMemberRecord)) {
    throw new HttpError(500, 'members_file_corrupt', 'members.json 结构不符合约定')
  }
  return members
}
