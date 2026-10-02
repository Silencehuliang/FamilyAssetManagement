/**
 * 账户服务:一次性初始化、登录、改密、管理员重置(ADR-0002)。
 * 依赖注入 LedgerStore,便于在 Vitest 中以内存仓库做行为级测试。
 */
import type { Member } from '../../domain/types'
import type { LedgerStore } from '../github'
import { createLedgerStore } from '../github'
import { HttpError } from '../http'
import {
  MEMBERS_FILE,
  type MemberRecord,
  parseMembers,
  serializeMembers,
  toPublicMember,
} from './members'
import { hashPassword, verifyPassword } from './password'
import { createSession } from './session'

export interface AuthDeps {
  store: LedgerStore
  secret: string
  now?: () => Date
  newId?: () => string
}

export interface AuthEnv {
  GITHUB_TOKEN?: string
  GITHUB_REPO?: string
  JWT_SECRET?: string
}

/** 从 Pages Function 环境变量组装依赖;缺失必需变量时返回 500 */
export function createAuthDeps(env: AuthEnv): AuthDeps {
  if (!env.JWT_SECRET) {
    throw new HttpError(500, 'missing_env', 'JWT_SECRET 未配置,无法签发会话')
  }
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
    throw new HttpError(500, 'missing_env', 'GITHUB_REPO / GITHUB_TOKEN 未配置,无法访问账本仓库')
  }
  return {
    store: createLedgerStore({ repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN }),
    secret: env.JWT_SECRET,
  }
}

async function loadMembers(deps: AuthDeps): Promise<{ members: MemberRecord[]; sha: string }> {
  const file = await deps.store.getFile(MEMBERS_FILE)
  if (!file) {
    throw new HttpError(500, 'members_file_missing', '账本仓库中缺少 members.json')
  }
  return { members: parseMembers(file.content), sha: file.sha }
}

async function saveMembers(deps: AuthDeps, members: MemberRecord[], sha: string): Promise<void> {
  await deps.store.putFile(MEMBERS_FILE, serializeMembers(members), sha)
}

export interface AuthResult {
  token: string
  member: Member
}

export interface InitializeInput {
  username: string
  displayName: string
  password: string
}

/** 一次性初始化:仅当仓库中不存在 members.json 时可创建管理员,否则 409 */
export async function initialize(deps: AuthDeps, input: InitializeInput): Promise<AuthResult> {
  const existing = await deps.store.getFile(MEMBERS_FILE)
  if (existing) {
    throw new HttpError(409, 'setup_already_done', '账本已完成初始化')
  }
  const now = deps.now ?? (() => new Date())
  const id = (deps.newId ?? (() => crypto.randomUUID()))()
  const credential = await hashPassword(input.password)
  const record: MemberRecord = {
    id,
    username: input.username,
    displayName: input.displayName,
    role: 'admin',
    disabled: false,
    createdAt: now().toISOString(),
    ...credential,
  }
  await deps.store.putFile(MEMBERS_FILE, serializeMembers([record]))
  const member = toPublicMember(record)
  return { token: await createSession(record, deps.secret, now()), member }
}

export interface LoginInput {
  username: string
  password: string
}

/** 登录:未知用户/错密码一律 401 不泄露存在性;停用账户 401 */
export async function login(deps: AuthDeps, input: LoginInput): Promise<AuthResult> {
  const { members } = await loadMembers(deps)
  const record = members.find((m) => m.username === input.username)
  if (!record || !(await verifyPassword(input.password, record))) {
    throw new HttpError(401, 'invalid_credentials', '用户名或密码错误')
  }
  if (record.disabled) {
    throw new HttpError(401, 'account_disabled', '该成员已停用')
  }
  const member = toPublicMember(record)
  return { token: await createSession(record, deps.secret), member }
}

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

/** 本人修改密码:必须提供当前密码 */
export async function changeOwnPassword(
  deps: AuthDeps,
  memberId: string,
  input: ChangePasswordInput,
): Promise<{ member: Member }> {
  const { members, sha } = await loadMembers(deps)
  const record = members.find((m) => m.id === memberId)
  if (!record) {
    throw new HttpError(401, 'unauthorized', '会话对应的成员不存在')
  }
  if (!(await verifyPassword(input.currentPassword, record))) {
    throw new HttpError(401, 'wrong_password', '当前密码错误')
  }
  Object.assign(record, await hashPassword(input.newPassword))
  await saveMembers(deps, members, sha)
  return { member: toPublicMember(record) }
}

export interface ResetPasswordInput {
  memberId: string
  newPassword: string
}

/** 管理员重置任意成员密码(角色门禁由 requireAdmin 在入口强制) */
export async function resetMemberPassword(
  deps: AuthDeps,
  input: ResetPasswordInput,
): Promise<{ member: Member }> {
  const { members, sha } = await loadMembers(deps)
  const record = members.find((m) => m.id === input.memberId)
  if (!record) {
    throw new HttpError(404, 'member_not_found', '成员不存在')
  }
  Object.assign(record, await hashPassword(input.newPassword))
  await saveMembers(deps, members, sha)
  return { member: toPublicMember(record) }
}
