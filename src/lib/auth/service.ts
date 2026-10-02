/**
 * 账户服务:一次性初始化、登录、改密、管理员建号/停用/重置(ADR-0002)。
 * 依赖注入 LedgerStore,便于在 Vitest 中以内存仓库做行为级测试。
 */
import type { Member } from '../../domain/types'
import type { LedgerStore } from '../github'
import { createLedgerStore } from '../github'
import { HttpError } from '../http'
import type { JwtPayload } from './jwt'
import {
  MEMBERS_FILE,
  type MemberRecord,
  type PasswordCredential,
  parseMembers,
  serializeMembers,
  toPublicMember,
} from './members'
import { hashPassword, verifyPassword } from './password'
import { createSession, requireAdmin, requireAuth } from './session'

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

/**
 * 账本是否已初始化(仓库中是否已存在 members.json)。
 * 供未携带会话的初始化探测使用:未初始化 → 初始化向导,已初始化 → 登录页。
 */
export async function isInitialized(deps: AuthDeps): Promise<boolean> {
  return (await deps.store.getFile(MEMBERS_FILE)) !== null
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
  try {
    await deps.store.putFile(MEMBERS_FILE, serializeMembers([record]))
  } catch (err) {
    // 并发初始化竞态:GitHub 对已存在文件的裸 PUT 返回 422 → 409
    if (err instanceof HttpError && err.code === 'file_conflict') {
      throw new HttpError(409, 'setup_already_done', '账本已完成初始化')
    }
    throw err
  }
  const member = toPublicMember(record)
  return { token: await createSession(record, deps.secret, now()), member }
}

export interface LoginInput {
  username: string
  password: string
}

/** 登录:未知用户/错密码一律 401 不泄露存在性(未知用户也执行一次 PBKDF2 抹平时序);停用账户 401 */
export async function login(deps: AuthDeps, input: LoginInput): Promise<AuthResult> {
  const { members } = await loadMembers(deps)
  const record = members.find((m) => m.username === input.username)
  if (!record) {
    await burnCredential(input.password)
    throw new HttpError(401, 'invalid_credentials', '用户名或密码错误')
  }
  if (!(await verifyPassword(input.password, record))) {
    throw new HttpError(401, 'invalid_credentials', '用户名或密码错误')
  }
  if (record.disabled) {
    throw new HttpError(401, 'account_disabled', '该成员已停用')
  }
  const member = toPublicMember(record)
  return { token: await createSession(record, deps.secret), member }
}

let burnCredentialPromise: Promise<PasswordCredential> | null = null

/** 未知用户也做一次等价 PBKDF2,避免响应时序泄露用户名存在性 */
async function burnCredential(password: string): Promise<boolean> {
  burnCredentialPromise ??= hashPassword(crypto.randomUUID())
  return verifyPassword(password, await burnCredentialPromise)
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

/** 全员公开的成员列表(去凭据):供经手人选择、成员识别 */
export async function listMembers(deps: AuthDeps): Promise<Member[]> {
  const { members } = await loadMembers(deps)
  return members.map(toPublicMember)
}

export interface CreateMemberInput {
  username: string
  displayName: string
  password: string
}

/** 管理员创建成员账户:用户名去空白后唯一,409 冲突;密码即刻哈希落盘 */
export async function createMember(
  deps: AuthDeps,
  input: CreateMemberInput,
): Promise<{ member: Member }> {
  const username = input.username.trim()
  const displayName = input.displayName.trim()
  if (username === '') throw new HttpError(400, 'invalid_request', 'username 不能为空')
  if (displayName === '') throw new HttpError(400, 'invalid_request', 'displayName 不能为空')
  if (input.password === '') throw new HttpError(400, 'invalid_request', 'password 不能为空')

  const { members, sha } = await loadMembers(deps)
  if (members.some((m) => m.username === username)) {
    throw new HttpError(409, 'member_duplicated', '用户名已存在')
  }
  const now = deps.now ?? (() => new Date())
  const id = (deps.newId ?? (() => crypto.randomUUID()))()
  const record: MemberRecord = {
    id,
    username,
    displayName,
    // 规格(T9):管理员创建的账户一律是普通成员;管理员仅由初始化产生
    role: 'member',
    disabled: false,
    createdAt: now().toISOString(),
    ...(await hashPassword(input.password)),
  }
  await saveMembers(deps, [...members, record], sha)
  return { member: toPublicMember(record) }
}

export interface SetMemberStatusInput {
  memberId: string
  disabled: boolean
}

/**
 * 管理员启用/停用成员:不允许停用自己(400),避免把全家的管理权限锁死。
 * 停用后目标成员的旧会话在下一次请求即被拒(见 createMemberStatusLookup)。
 */
export async function setMemberStatus(
  deps: AuthDeps,
  actorId: string,
  input: SetMemberStatusInput,
): Promise<{ member: Member }> {
  const { members, sha } = await loadMembers(deps)
  const record = members.find((m) => m.id === input.memberId)
  if (!record) {
    throw new HttpError(404, 'member_not_found', '成员不存在')
  }
  if (input.disabled && record.id === actorId) {
    throw new HttpError(400, 'cannot_disable_self', '不能停用自己的账户')
  }
  record.disabled = input.disabled
  await saveMembers(deps, members, sha)
  invalidateMemberStatus(input.memberId)
  return { member: toPublicMember(record) }
}

/** 停用状态的缓存条目;expiresAt 为毫秒时间戳 */
export interface MemberStatusCacheEntry {
  disabled: boolean
  expiresAt: number
}

export interface MemberStatusLookupOptions {
  /** 缓存有效期,默认 30s(每个 isolate 一份,避免每个请求读一次 GitHub) */
  ttlMs?: number
  /** 时钟注入(测试);默认 Date.now */
  now?: () => number
  /** 缓存注入(测试);默认模块级共享缓存 */
  cache?: Map<string, MemberStatusCacheEntry>
}

/**
 * 停用状态缓存 TTL。默认 0 = 不缓存,每个鉴权请求都读 members.json ——
 * 「停用立即生效」是 T9 的验收标准,多 isolate 下只能靠不缓存来保证;
 * 家庭规模下每请求一次 GitHub 读取完全可接受。大于 0 仅用于测试/降载场景。
 */
export const DEFAULT_MEMBER_STATUS_TTL_MS = 0

const memberStatusCache = new Map<string, MemberStatusCacheEntry>()

/** 清空默认缓存(测试隔离;停用/启用某成员时也会定向失效) */
export function clearMemberStatusCache(): void {
  memberStatusCache.clear()
}

/** 定向失效某成员的停用状态缓存(管理员停用/启用后由 setMemberStatus 调用) */
export function invalidateMemberStatus(memberId: string): void {
  memberStatusCache.delete(memberId)
}

/**
 * 组装「成员是否已停用」查询:命中未过期缓存直接返回,否则读 members.json。
 * 成员不存在视为已停用(会话对应的账户已被移除时拒绝访问)。
 */
export function createMemberStatusLookup(
  deps: AuthDeps,
  options: MemberStatusLookupOptions = {},
): (memberId: string) => Promise<boolean> {
  const ttlMs = options.ttlMs ?? DEFAULT_MEMBER_STATUS_TTL_MS
  const now = options.now ?? (() => Date.now())
  const cache = options.cache ?? memberStatusCache
  return async (memberId: string): Promise<boolean> => {
    const current = now()
    const cached = cache.get(memberId)
    if (cached && cached.expiresAt > current) return cached.disabled

    const { members } = await loadMembers(deps)
    const record = members.find((m) => m.id === memberId)
    const disabled = record ? record.disabled : true
    cache.set(memberId, { disabled, expiresAt: current + ttlMs })
    return disabled
  }
}

/** 校验会话并确认成员当前未被停用(所有需要账户有效的端点的统一入口) */
export async function requireActiveAuth(request: Request, deps: AuthDeps): Promise<JwtPayload> {
  return requireAuth(request, deps.secret, createMemberStatusLookup(deps))
}

/** 校验会话 + 管理员角色,并要求账户未被停用 */
export async function requireActiveAdmin(request: Request, deps: AuthDeps): Promise<JwtPayload> {
  return requireAdmin(request, deps.secret, createMemberStatusLookup(deps))
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
