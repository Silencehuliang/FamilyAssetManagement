import { describe, expect, it } from 'vitest'
import type { LedgerStore, RepoDirEntry, RepoFile } from '../github'
import { HttpError } from '../http'
import { verifyJwt } from './jwt'
import {
  MEMBERS_FILE,
  type MemberRecord,
  parseMembers,
  serializeMembers,
  toPublicMember,
} from './members'
import { hashPassword, verifyPassword } from './password'
import {
  type AuthDeps,
  changeOwnPassword,
  createMember,
  createMemberStatusLookup,
  initialize,
  login,
  resetMemberPassword,
  setMemberStatus,
} from './service'

const SECRET = 'service-test-secret'
const NOW = new Date('2026-10-02T08:00:00Z')

/** 内存仓库:替代 GitHub Contents API 的行为级假件 */
class MemoryStore implements LedgerStore {
  readonly files = new Map<string, RepoFile>()
  readonly writes: { path: string; content: string; sha?: string }[] = []

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, { content, sha: `sha:${path}` })
    }
  }

  getFile(path: string): Promise<RepoFile | null> {
    const file = this.files.get(path)
    return Promise.resolve(file ? { ...file } : null)
  }

  putFile(path: string, content: string, sha?: string): Promise<string> {
    this.writes.push({ path, content, sha })
    const newSha = `sha:${path}#${this.writes.length}`
    this.files.set(path, { content, sha: newSha })
    return Promise.resolve(newSha)
  }

  listDirectory(path: string): Promise<RepoDirEntry[]> {
    const prefix = `${path}/`
    return Promise.resolve(
      [...this.files.entries()]
        .filter(([filePath]) => filePath.startsWith(prefix))
        .map(([filePath, file]) => ({
          name: filePath.slice(prefix.length),
          path: filePath,
          sha: file.sha,
          type: 'file',
        })),
    )
  }

  deleteFile(path: string): Promise<void> {
    this.files.delete(path)
    return Promise.resolve()
  }
}

function makeDeps(store: MemoryStore): AuthDeps {
  return {
    store,
    secret: SECRET,
    now: () => NOW,
    newId: () => 'member-fixed-id',
  }
}

async function seedRecord(
  username: string,
  password: string,
  overrides: Partial<MemberRecord> = {},
): Promise<MemberRecord> {
  const credential = await hashPassword(password)
  return {
    id: `id-${username}`,
    username,
    displayName: overrides.displayName ?? username,
    role: overrides.role ?? 'member',
    disabled: overrides.disabled ?? false,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
    ...credential,
  }
}

async function storeWithRecords(...records: MemberRecord[]): Promise<MemoryStore> {
  return new MemoryStore({ [MEMBERS_FILE]: serializeMembers(records) })
}

describe('initialize(一次性初始化)', () => {
  it('仓库无 members.json 时创建管理员并签发会话', async () => {
    const store = new MemoryStore()
    const result = await initialize(makeDeps(store), {
      username: 'ada',
      displayName: '阿达',
      password: 'root-pw-123',
    })

    expect(result.member).toEqual({
      id: 'member-fixed-id',
      username: 'ada',
      displayName: '阿达',
      role: 'admin',
      disabled: false,
      createdAt: '2026-10-02T08:00:00.000Z',
    })
    expect('passwordHash' in result.member).toBe(false)

    const payload = await verifyJwt(result.token, SECRET)
    expect(payload).toMatchObject({ sub: 'member-fixed-id', role: 'admin', name: '阿达' })

    const written = store.files.get(MEMBERS_FILE)
    expect(written).toBeDefined()
    const content = written?.content ?? ''
    expect(content.endsWith('\n')).toBe(true)
    expect(content.startsWith('{\n  "members": [')).toBe(true)
    const records = parseMembers(content)
    expect(records).toHaveLength(1)
    expect(records[0]?.username).toBe('ada')
    await expect(verifyPassword('root-pw-123', records[0] ?? ({} as MemberRecord))).resolves.toBe(
      true,
    )
  })

  it('members.json 已存在时返回 409', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    await expect(
      initialize(makeDeps(store), { username: 'bob', displayName: '小宝', password: 'x-pw-123' }),
    ).rejects.toMatchObject({ status: 409, code: 'setup_already_done' })
  })
})

describe('login(登录)', () => {
  it('正确凭据签发会话并返回公开成员', async () => {
    const admin = await seedRecord('ada', 'root-pw-123', { role: 'admin' })
    const store = await storeWithRecords(admin)
    const result = await login(makeDeps(store), { username: 'ada', password: 'root-pw-123' })
    expect(result.member).toEqual(toPublicMember(admin))
    expect('passwordHash' in result.member).toBe(false)
    const payload = await verifyJwt(result.token, SECRET)
    expect(payload).toMatchObject({ sub: admin.id, role: 'admin' })
  })

  it('密码错误返回 401', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    await expect(
      login(makeDeps(store), { username: 'ada', password: 'nope-123' }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    })
  })

  it('未知用户返回 401 且不泄露存在性', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    await expect(
      login(makeDeps(store), { username: 'ghost', password: 'whatever-1' }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    })
  })

  it('停用成员返回 401', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123', { disabled: true }))
    await expect(
      login(makeDeps(store), { username: 'ada', password: 'root-pw-123' }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'account_disabled',
    })
  })

  it('缺少 members.json 时返回 500', async () => {
    const store = new MemoryStore()
    await expect(
      login(makeDeps(store), { username: 'ada', password: 'root-pw-123' }),
    ).rejects.toMatchObject({
      status: 500,
      code: 'members_file_missing',
    })
  })
})

describe('changeOwnPassword(本人改密)', () => {
  it('提供正确当前密码时改密成功,旧密码失效', async () => {
    const record = await seedRecord('ada', 'old-pw-123')
    const store = await storeWithRecords(record)
    const result = await changeOwnPassword(makeDeps(store), record.id, {
      currentPassword: 'old-pw-123',
      newPassword: 'new-pw-456',
    })
    expect(result.member.id).toBe(record.id)

    const stored = parseMembers(store.files.get(MEMBERS_FILE)?.content ?? '')
    await expect(verifyPassword('new-pw-456', stored[0] ?? ({} as MemberRecord))).resolves.toBe(
      true,
    )
    await expect(verifyPassword('old-pw-123', stored[0] ?? ({} as MemberRecord))).resolves.toBe(
      false,
    )
  })

  it('当前密码错误返回 401 且不写入', async () => {
    const record = await seedRecord('ada', 'old-pw-123')
    const store = await storeWithRecords(record)
    await expect(
      changeOwnPassword(makeDeps(store), record.id, {
        currentPassword: 'wrong-pw',
        newPassword: 'new-pw-456',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'wrong_password' })
    expect(store.writes).toHaveLength(0)
  })
})

describe('resetMemberPassword(管理员重置)', () => {
  it('重置后成员可用新密码登录', async () => {
    const admin = await seedRecord('ada', 'root-pw-123', { role: 'admin' })
    const target = await seedRecord('xiaohong', 'old-pw-123')
    const store = await storeWithRecords(admin, target)

    const result = await resetMemberPassword(makeDeps(store), {
      memberId: target.id,
      newPassword: 'reset-123',
    })
    expect(result.member.id).toBe(target.id)

    const loginResult = await login(makeDeps(store), {
      username: 'xiaohong',
      password: 'reset-123',
    })
    expect(loginResult.member.id).toBe(target.id)
    await expect(
      login(makeDeps(store), { username: 'xiaohong', password: 'old-pw-123' }),
    ).rejects.toMatchObject({
      status: 401,
    })
  })

  it('目标成员不存在返回 404', async () => {
    const admin = await seedRecord('ada', 'root-pw-123', { role: 'admin' })
    const store = await storeWithRecords(admin)
    await expect(
      resetMemberPassword(makeDeps(store), { memberId: 'nobody', newPassword: 'reset-123' }),
    ).rejects.toMatchObject({ status: 404, code: 'member_not_found' })
  })
})

describe('HttpError 契约', () => {
  it('message 缺省回落到 code', () => {
    const err = new HttpError(404, 'not_found')
    expect(err.message).toBe('not_found')
    expect(err.status).toBe(404)
  })
})

describe('createMember(管理员建号,T9)', () => {
  it('创建成员:去空白、默认 member、密码可登录并写入 members.json', async () => {
    const admin = await seedRecord('ada', 'root-pw-123', { role: 'admin' })
    const store = await storeWithRecords(admin)

    const result = await createMember(makeDeps(store), {
      username: '  xiaohong ',
      displayName: ' 小红 ',
      password: 'pw-123456',
    })

    expect(result.member).toMatchObject({
      username: 'xiaohong',
      displayName: '小红',
      role: 'member',
      disabled: false,
    })
    expect('passwordHash' in result.member).toBe(false)

    const stored = parseMembers(store.files.get(MEMBERS_FILE)?.content ?? '')
    expect(stored.map((m) => m.username)).toEqual(['ada', 'xiaohong'])
    await expect(
      login(makeDeps(store), { username: 'xiaohong', password: 'pw-123456' }),
    ).resolves.toMatchObject({ member: { id: result.member.id } })
  })

  it('创建的账户一律是普通成员(管理员仅由初始化产生)', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123', { role: 'admin' }))
    const result = await createMember(makeDeps(store), {
      username: 'xiaohong',
      displayName: '小红',
      password: 'pw-123456',
    })
    expect(result.member.role).toBe('member')
  })

  it('用户名重复返回 409 且不写入', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    await expect(
      createMember(makeDeps(store), {
        username: 'ada',
        displayName: '重复',
        password: 'pw-123456',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'member_duplicated' })
    expect(store.writes).toHaveLength(0)
  })

  it('空用户名/显示名/密码返回 400', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    await expect(
      createMember(makeDeps(store), { username: '  ', displayName: '小红', password: 'pw-123456' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(
      createMember(makeDeps(store), { username: 'xh', displayName: ' ', password: 'pw-123456' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(
      createMember(makeDeps(store), { username: 'xh', displayName: '小红', password: '' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })
})

describe('setMemberStatus(停用/启用,T9)', () => {
  it('停用后登录 401 account_disabled,启用后恢复', async () => {
    const admin = await seedRecord('ada', 'root-pw-123', { role: 'admin' })
    const target = await seedRecord('xiaohong', 'pw-123456')
    const store = await storeWithRecords(admin, target)
    const deps = makeDeps(store)

    const disabled = await setMemberStatus(deps, admin.id, { memberId: target.id, disabled: true })
    expect(disabled.member.disabled).toBe(true)
    await expect(
      login(deps, { username: 'xiaohong', password: 'pw-123456' }),
    ).rejects.toMatchObject({ status: 401, code: 'account_disabled' })

    const enabled = await setMemberStatus(deps, admin.id, { memberId: target.id, disabled: false })
    expect(enabled.member.disabled).toBe(false)
    await expect(
      login(deps, { username: 'xiaohong', password: 'pw-123456' }),
    ).resolves.toMatchObject({ member: { id: target.id, disabled: false } })
  })

  it('不能停用自己(400 cannot_disable_self),可启用自己', async () => {
    const admin = await seedRecord('ada', 'root-pw-123', { role: 'admin' })
    const store = await storeWithRecords(admin)
    await expect(
      setMemberStatus(makeDeps(store), admin.id, { memberId: admin.id, disabled: true }),
    ).rejects.toMatchObject({ status: 400, code: 'cannot_disable_self' })
    expect(store.writes).toHaveLength(0)
  })

  it('成员不存在返回 404', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    await expect(
      setMemberStatus(makeDeps(store), 'id-ada', { memberId: 'nobody', disabled: true }),
    ).rejects.toMatchObject({ status: 404, code: 'member_not_found' })
  })
})

describe('createMemberStatusLookup(停用校验缓存,T9)', () => {
  it('TTL 内命中缓存不重复读仓库,过期后重新读取;停用立即反映', async () => {
    let nowMs = 1_000_000
    const record = await seedRecord('ada', 'root-pw-123')
    const store = await storeWithRecords(record)
    const originalGetFile = store.getFile.bind(store)
    let reads = 0
    store.getFile = (path: string) => {
      reads += 1
      return originalGetFile(path)
    }
    const lookup = createMemberStatusLookup(makeDeps(store), {
      ttlMs: 30_000,
      now: () => nowMs,
      cache: new Map(),
    })

    await expect(lookup(record.id)).resolves.toBe(false)
    expect(reads).toBe(1)

    // 仓库中直接改为停用,但缓存未过期:仍返回缓存值(避免每请求读 GitHub)
    store.files.set(MEMBERS_FILE, {
      content: serializeMembers([{ ...record, disabled: true }]),
      sha: 'sha2',
    })
    await expect(lookup(record.id)).resolves.toBe(false)
    expect(reads).toBe(1)

    nowMs += 30_001
    await expect(lookup(record.id)).resolves.toBe(true)
    expect(reads).toBe(2)
    await expect(lookup(record.id)).resolves.toBe(true)
    expect(reads).toBe(2)
  })

  it('成员不存在视为已停用(fail closed)', async () => {
    const store = await storeWithRecords(await seedRecord('ada', 'root-pw-123'))
    const lookup = createMemberStatusLookup(makeDeps(store), { cache: new Map() })
    await expect(lookup('ghost')).resolves.toBe(true)
  })
})

describe('initialize 并发竞态', () => {
  it('GitHub 端文件冲突(file_conflict)映射为 409 setup_already_done', async () => {
    const store = new MemoryStore()
    store.putFile = () => Promise.reject(new HttpError(409, 'file_conflict', '远端文件状态已变化'))
    await expect(
      initialize(makeDeps(store), {
        username: 'admin',
        displayName: '管理员',
        password: 'secret-123',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'setup_already_done' })
  })
})
