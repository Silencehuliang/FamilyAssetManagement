import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type JwtPayload, verifyJwt } from '../../src/lib/auth/jwt'
import {
  MEMBERS_FILE,
  type MemberRecord,
  parseMembers,
  serializeMembers,
} from '../../src/lib/auth/members'
import { hashPassword } from '../../src/lib/auth/password'
import { clearMemberStatusCache } from '../../src/lib/auth/service'
import { createSession } from '../../src/lib/auth/session'
import { onRequestPost as changePasswordPost } from './auth/password'
import {
  onRequestDelete as ledgerDelete,
  onRequestGet as ledgerGet,
  onRequestPut as ledgerPut,
} from './ledger/file'
import { onRequestGet as ledgerListGet } from './ledger/list'
import { onRequestPost as loginPost } from './login'
import { onRequestGet as membersGet, onRequestPost as membersPost } from './members'
import { onRequestPost as resetPasswordPost } from './members/password'
import { onRequestPost as memberStatusPost } from './members/status'
import { onRequestPost as setupPost } from './setup'

const ENV = {
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_REPO: 'family/ledger',
  JWT_SECRET: 'test-jwt-secret',
}

const BASE = 'https://family-ledger.pages.dev'

interface StubRequest {
  method: string
  path: string
}

/** 模拟 GitHub Contents API,按账本路径存取文件 */
function githubStub(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const shas = new Map<string, string>()
  for (const path of files.keys()) shas.set(path, `sha:${path}`)
  const requests: StubRequest[] = []
  let counter = 0

  const decodePath = (url: URL): string => {
    const marker = '/contents/'
    const index = url.pathname.indexOf(marker)
    if (index < 0) {
      throw new Error(`未预期的请求: ${url.pathname}`)
    }
    return url.pathname
      .slice(index + marker.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  }

  const decodeBase64Utf8 = (base64: string): string => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
  }

  const encodeBase64Utf8 = (text: string): string => {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }

  const impl = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const path = decodePath(url)
    const method = init?.method ?? 'GET'
    requests.push({ method, path })
    if (method === 'PUT') {
      const payload = JSON.parse(String(init?.body)) as { content: string }
      const content = decodeBase64Utf8(payload.content)
      files.set(path, content)
      const sha = `new-sha-${++counter}`
      shas.set(path, sha)
      return Promise.resolve(Response.json({ content: { sha } }, { status: 201 }))
    }
    if (method === 'DELETE') {
      const payload = JSON.parse(String(init?.body)) as { sha?: string }
      if (!files.has(path) || payload.sha !== shas.get(path)) {
        return Promise.resolve(Response.json({ message: 'Conflict' }, { status: 422 }))
      }
      files.delete(path)
      shas.delete(path)
      return Promise.resolve(Response.json({ commit: { sha: `del-sha-${++counter}` } }))
    }
    const content = files.get(path)
    if (content === undefined) {
      // 目录形态:路径下存在文件时返回目录列表
      const prefix = `${path}/`
      const entries = [...files.keys()]
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => ({
          name: filePath.slice(prefix.length),
          path: filePath,
          sha: shas.get(filePath),
          type: 'file',
        }))
      if (entries.length > 0) {
        return Promise.resolve(Response.json(entries))
      }
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    return Promise.resolve(
      Response.json({
        content: encodeBase64Utf8(content),
        encoding: 'base64',
        sha: shas.get(path),
      }),
    )
  }
  return { impl, requests, files, encodeBase64Utf8 }
}

async function seededMember(
  username: string,
  password: string,
  overrides: Partial<MemberRecord> = {},
): Promise<MemberRecord> {
  return {
    id: overrides.id ?? `id-${username}`,
    username,
    displayName: overrides.displayName ?? username,
    role: overrides.role ?? 'member',
    disabled: overrides.disabled ?? false,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...(await hashPassword(password)),
    ...overrides,
  }
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify(body),
  })
}

function ledgerPutRequest(body: unknown, token: string): Request {
  return new Request(`${BASE}/api/ledger/file`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

let stub: ReturnType<typeof githubStub>

beforeEach(() => {
  stub = githubStub()
  vi.stubGlobal('fetch', stub.impl)
  // 停用状态查询使用模块级短 TTL 缓存;测试间隔离,避免同 id 缓存串味
  clearMemberStatusCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/setup', () => {
  it('首次初始化:创建管理员、写入 members.json 并返回会话', async () => {
    const response = await setupPost({
      request: post('/api/setup', {
        username: 'ada',
        displayName: '阿达',
        password: 'root-pw-123',
      }),
      env: ENV,
    })

    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    const member = body.member as Record<string, unknown>
    expect(member.username).toBe('ada')
    expect(member.role).toBe('admin')
    expect('passwordHash' in member).toBe(false)
    const payload = (await verifyJwt(String(body.token), ENV.JWT_SECRET)) as JwtPayload | null
    expect(payload).toMatchObject({ role: 'admin', name: '阿达' })

    expect(stub.requests).toContainEqual({ method: 'PUT', path: MEMBERS_FILE })
    const records = parseMembers(stub.files.get(MEMBERS_FILE) ?? '')
    expect(records).toHaveLength(1)
    expect(stub.files.get(MEMBERS_FILE)?.endsWith('\n')).toBe(true)
  })

  it('已初始化后再次调用返回 409', async () => {
    stub = githubStub({
      [MEMBERS_FILE]: serializeMembers([await seededMember('ada', 'root-pw-123')]),
    })
    vi.stubGlobal('fetch', stub.impl)

    const response = await setupPost({
      request: post('/api/setup', { username: 'bob', displayName: '小宝', password: 'other-123' }),
      env: ENV,
    })

    expect(response.status).toBe(409)
    expect(await jsonOf(response)).toMatchObject({ error: 'setup_already_done' })
  })

  it('缺少 JWT_SECRET 返回 500 与明确错误', async () => {
    const response = await setupPost({
      request: post('/api/setup', {
        username: 'ada',
        displayName: '阿达',
        password: 'root-pw-123',
      }),
      env: { ...ENV, JWT_SECRET: undefined },
    })

    expect(response.status).toBe(500)
    expect(await jsonOf(response)).toMatchObject({ error: 'missing_env' })
  })

  it('请求体缺字段返回 400', async () => {
    const response = await setupPost({
      request: post('/api/setup', { username: 'ada' }),
      env: ENV,
    })
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toMatchObject({ error: 'invalid_request' })
  })
})

describe('POST /api/login', () => {
  it('正确凭据返回会话', async () => {
    const record = await seededMember('ada', 'pw-123456', { role: 'admin' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([record]) })
    vi.stubGlobal('fetch', stub.impl)

    const response = await loginPost({
      request: post('/api/login', { username: 'ada', password: 'pw-123456' }),
      env: ENV,
    })

    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect(await verifyJwt(String(body.token), ENV.JWT_SECRET)).toMatchObject({ sub: record.id })
  })

  it('错误密码返回 401', async () => {
    stub = githubStub({
      [MEMBERS_FILE]: serializeMembers([await seededMember('ada', 'pw-123456')]),
    })
    vi.stubGlobal('fetch', stub.impl)

    const response = await loginPost({
      request: post('/api/login', { username: 'ada', password: 'wrong-pw' }),
      env: ENV,
    })

    expect(response.status).toBe(401)
    expect(await jsonOf(response)).toMatchObject({ error: 'invalid_credentials' })
  })
})

describe('POST /api/auth/password', () => {
  it('本人修改密码生效', async () => {
    const record = await seededMember('ada', 'old-pw-123')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([record]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(record, ENV.JWT_SECRET)

    const response = await changePasswordPost({
      request: post(
        '/api/auth/password',
        { currentPassword: 'old-pw-123', newPassword: 'new-pw-456' },
        token,
      ),
      env: ENV,
    })
    expect(response.status).toBe(200)

    const relogin = await loginPost({
      request: post('/api/login', { username: 'ada', password: 'new-pw-456' }),
      env: ENV,
    })
    expect(relogin.status).toBe(200)
  })

  it('当前密码错误返回 401', async () => {
    const record = await seededMember('ada', 'old-pw-123')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([record]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(record, ENV.JWT_SECRET)

    const response = await changePasswordPost({
      request: post(
        '/api/auth/password',
        { currentPassword: 'wrong-pw', newPassword: 'new-pw-456' },
        token,
      ),
      env: ENV,
    })

    expect(response.status).toBe(401)
    expect(await jsonOf(response)).toMatchObject({ error: 'wrong_password' })
  })
})

describe('POST /api/members/password', () => {
  it('管理员重置成员密码生效', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin', id: 'id-ada' })
    const member = await seededMember('xiaohong', 'old-pw-123', { id: 'id-xiaohong' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin, member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(admin, ENV.JWT_SECRET)

    const response = await resetPasswordPost({
      request: post(
        '/api/members/password',
        { memberId: member.id, newPassword: 'reset-pw-9' },
        token,
      ),
      env: ENV,
    })
    expect(response.status).toBe(200)

    const relogin = await loginPost({
      request: post('/api/login', { username: 'xiaohong', password: 'reset-pw-9' }),
      env: ENV,
    })
    expect(relogin.status).toBe(200)
  })

  it('普通成员调用返回 403', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await resetPasswordPost({
      request: post(
        '/api/members/password',
        { memberId: member.id, newPassword: 'reset-pw-9' },
        token,
      ),
      env: ENV,
    })

    expect(response.status).toBe(403)
    expect(await jsonOf(response)).toMatchObject({ error: 'forbidden' })
  })
})

describe('POST /api/members(管理员建号,T9)', () => {
  it('管理员创建成员并返回公开成员;新成员可登录', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin', id: 'id-ada' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(admin, ENV.JWT_SECRET)

    const response = await membersPost({
      request: post(
        '/api/members',
        { username: 'xiaohong', displayName: '小红', password: 'pw-123456' },
        token,
      ),
      env: ENV,
    })

    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect(body.member).toMatchObject({
      username: 'xiaohong',
      displayName: '小红',
      role: 'member',
      disabled: false,
    })
    expect(JSON.stringify(body)).not.toContain('passwordHash')
    expect(JSON.stringify(body)).not.toContain('passwordSalt')

    const relogin = await loginPost({
      request: post('/api/login', { username: 'xiaohong', password: 'pw-123456' }),
      env: ENV,
    })
    expect(relogin.status).toBe(200)
  })

  it('用户名重复返回 409 member_duplicated,不产生第二次写入', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(admin, ENV.JWT_SECRET)

    const response = await membersPost({
      request: post(
        '/api/members',
        { username: 'ada', displayName: '重复', password: 'pw-123456' },
        token,
      ),
      env: ENV,
    })

    expect(response.status).toBe(409)
    expect(await jsonOf(response)).toMatchObject({ error: 'member_duplicated' })
  })

  it('普通成员调用返回 403;缺字段返回 400;role 参数被忽略,一律创建为普通成员', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const denied = await membersPost({
      request: post(
        '/api/members',
        { username: 'dali', displayName: '大力', password: 'pw-123456' },
        token,
      ),
      env: ENV,
    })
    expect(denied.status).toBe(403)
    expect(await jsonOf(denied)).toMatchObject({ error: 'forbidden' })

    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin]) })
    vi.stubGlobal('fetch', stub.impl)
    const adminToken = await createSession(admin, ENV.JWT_SECRET)

    const missing = await membersPost({
      request: post('/api/members', { username: 'dali' }, adminToken),
      env: ENV,
    })
    expect(missing.status).toBe(400)

    const ignoredRole = await membersPost({
      request: post(
        '/api/members',
        { username: 'dali', displayName: '大力', password: 'pw-123456', role: 'owner' },
        adminToken,
      ),
      env: ENV,
    })
    expect(ignoredRole.status).toBe(200)
    expect(await jsonOf(ignoredRole)).toMatchObject({
      member: { username: 'dali', role: 'member' },
    })
  })
})

describe('POST /api/members/status(停用/启用,T9)', () => {
  it('停用后成员已签发会话的请求立即被拒(401 account_disabled),启用后恢复', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin', id: 'id-ada' })
    const member = await seededMember('xiaohong', 'pw-123456', { id: 'id-xiaohong' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin, member]) })
    vi.stubGlobal('fetch', stub.impl)
    const adminToken = await createSession(admin, ENV.JWT_SECRET)
    const memberToken = await createSession(member, ENV.JWT_SECRET)

    const before = await membersGet({
      request: new Request(`${BASE}/api/members`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      env: ENV,
    })
    expect(before.status).toBe(200)

    const disabled = await memberStatusPost({
      request: post('/api/members/status', { memberId: member.id, disabled: true }, adminToken),
      env: ENV,
    })
    expect(disabled.status).toBe(200)
    expect((await jsonOf(disabled)).member).toMatchObject({ id: member.id, disabled: true })

    const denied = await membersGet({
      request: new Request(`${BASE}/api/members`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      env: ENV,
    })
    expect(denied.status).toBe(401)
    expect(await jsonOf(denied)).toMatchObject({ error: 'account_disabled' })

    const deniedSync = await ledgerListGet({
      request: new Request(`${BASE}/api/ledger/list`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      env: ENV,
    })
    expect(deniedSync.status).toBe(401)
    expect(await jsonOf(deniedSync)).toMatchObject({ error: 'account_disabled' })

    const enabled = await memberStatusPost({
      request: post('/api/members/status', { memberId: member.id, disabled: false }, adminToken),
      env: ENV,
    })
    expect(enabled.status).toBe(200)
    const restored = await membersGet({
      request: new Request(`${BASE}/api/members`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      env: ENV,
    })
    expect(restored.status).toBe(200)
  })

  it('不能停用自己(400 cannot_disable_self);普通成员 403;成员不存在 404', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin', id: 'id-ada' })
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin, member]) })
    vi.stubGlobal('fetch', stub.impl)
    const adminToken = await createSession(admin, ENV.JWT_SECRET)
    const memberToken = await createSession(member, ENV.JWT_SECRET)

    const self = await memberStatusPost({
      request: post('/api/members/status', { memberId: admin.id, disabled: true }, adminToken),
      env: ENV,
    })
    expect(self.status).toBe(400)
    expect(await jsonOf(self)).toMatchObject({ error: 'cannot_disable_self' })

    const denied = await memberStatusPost({
      request: post('/api/members/status', { memberId: admin.id, disabled: true }, memberToken),
      env: ENV,
    })
    expect(denied.status).toBe(403)

    const notFound = await memberStatusPost({
      request: post('/api/members/status', { memberId: 'nobody', disabled: true }, adminToken),
      env: ENV,
    })
    expect(notFound.status).toBe(404)
    expect(await jsonOf(notFound)).toMatchObject({ error: 'member_not_found' })
  })
})

describe('GET /api/ledger/file', () => {
  const MONTH_FILE = 'ledger/months/2026-10.json'

  it('已认证成员读取账本文件', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({
      [MONTH_FILE]: '{"expenses":[]}',
      [MEMBERS_FILE]: serializeMembers([member]),
    })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await ledgerGet({
      request: new Request(`${BASE}/api/ledger/file?path=${encodeURIComponent(MONTH_FILE)}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env: ENV,
    })

    expect(response.status).toBe(200)
    expect(await jsonOf(response)).toEqual({ content: '{"expenses":[]}', sha: `sha:${MONTH_FILE}` })
  })

  it('无令牌返回 401', async () => {
    const response = await ledgerGet({
      request: new Request(`${BASE}/api/ledger/file?path=${encodeURIComponent(MONTH_FILE)}`),
      env: ENV,
    })
    expect(response.status).toBe(401)
    expect(await jsonOf(response)).toMatchObject({ error: 'unauthorized' })
  })

  it('路径不在 ledger/ 下返回 400', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await ledgerGet({
      request: new Request(`${BASE}/api/ledger/file?path=${encodeURIComponent('README.md')}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env: ENV,
    })

    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toMatchObject({ error: 'invalid_path' })
  })
})

describe('PUT /api/ledger/file', () => {
  const MONTH_FILE = 'ledger/months/2026-10.json'

  it('普通成员写 members.json 返回 403', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await ledgerPut({
      request: ledgerPutRequest({ path: MEMBERS_FILE, content: '{"members":[]}' }, token),
      env: ENV,
    })

    expect(response.status).toBe(403)
    expect(await jsonOf(response)).toMatchObject({ error: 'members_server_owned' })
    expect(stub.requests).not.toContainEqual({ method: 'PUT', path: MEMBERS_FILE })
  })

  it('管理员写月文件生效并返回新 sha', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(admin, ENV.JWT_SECRET)

    const response = await ledgerPut({
      request: ledgerPutRequest(
        { path: MONTH_FILE, content: '{"expenses":[]}', sha: 'sha:known' },
        token,
      ),
      env: ENV,
    })

    expect(response.status).toBe(200)
    expect(await jsonOf(response)).toMatchObject({ sha: 'new-sha-1' })
    expect(stub.files.get(MONTH_FILE)).toBe('{"expenses":[]}')
  })

  it('普通成员可写 tags.json;写 tagGroups.json 返回 403', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const allowed = await ledgerPut({
      request: ledgerPutRequest({ path: 'ledger/meta/tags.json', content: '{"tags":[]}' }, token),
      env: ENV,
    })
    expect(allowed.status).toBe(200)

    const denied = await ledgerPut({
      request: ledgerPutRequest(
        { path: 'ledger/meta/tagGroups.json', content: '{"groups":[]}' },
        token,
      ),
      env: ENV,
    })
    expect(denied.status).toBe(403)
    expect(await jsonOf(denied)).toMatchObject({ error: 'forbidden' })
  })

  it('管理员可写 tags.json 与 tagGroups.json(契约矩阵补全)', async () => {
    const admin = await seededMember('ada', 'admin-pw-1', { role: 'admin' })
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([admin]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(admin, ENV.JWT_SECRET)

    const cases = [
      { path: 'ledger/meta/tags.json', content: '{"tags":[]}' },
      { path: 'ledger/meta/tagGroups.json', content: '{"groups":[]}' },
    ]
    for (const input of cases) {
      const response = await ledgerPut({
        request: ledgerPutRequest(input, token),
        env: ENV,
      })
      expect(response.status).toBe(200)
      expect(await jsonOf(response)).toMatchObject({ sha: expect.any(String) })
      expect(stub.files.get(input.path)).toBe(input.content)
    }
  })
})

describe('GET /api/members', () => {
  it('返回去凭据的成员列表;未认证 401', async () => {
    const ada = await seededMember('ada', 'ada-pw-123')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([ada]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(ada, ENV.JWT_SECRET)

    const ok = await membersGet({
      request: new Request(`${BASE}/api/members`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env: ENV,
    })
    const body = (await ok.json()) as { members: Array<Record<string, unknown>> }
    expect(ok.status).toBe(200)
    expect(body.members).toHaveLength(1)
    expect(body.members[0]).toMatchObject({ username: 'ada' })
    expect(JSON.stringify(body)).not.toContain('passwordHash')
    expect(JSON.stringify(body)).not.toContain('passwordSalt')

    const denied = await membersGet({ request: new Request(`${BASE}/api/members`), env: ENV })
    expect(denied.status).toBe(401)
  })

  it('未认证探测:仓库无 members.json 返回 500 members_file_missing(未初始化)', async () => {
    stub = githubStub()
    vi.stubGlobal('fetch', stub.impl)

    const response = await membersGet({ request: new Request(`${BASE}/api/members`), env: ENV })

    expect(response.status).toBe(500)
    expect(await jsonOf(response)).toMatchObject({ error: 'members_file_missing' })
  })
})

describe('GET /api/ledger/list', () => {
  const MONTH_FILE = 'ledger/months/2026-10.json'
  const CATEGORIES = 'ledger/meta/categories.json'
  const BUDGETS = 'ledger/meta/budgets.json'
  const RECURRING = 'ledger/meta/recurring.json'

  it('返回月份文件与三个 meta 文件;members.json 永不包含', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({
      [MONTH_FILE]: '{\n  "expenses": []\n}\n',
      [CATEGORIES]: '{\n  "categories": []\n}\n',
      [BUDGETS]: '{\n  "budgets": {}\n}\n',
      [RECURRING]: '{\n  "recurring": []\n}\n',
      [MEMBERS_FILE]: serializeMembers([member]),
    })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await ledgerListGet({
      request: new Request(`${BASE}/api/ledger/list`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env: ENV,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      files: Record<string, { content: string; revision: string }>
    }
    expect(Object.keys(body.files).sort()).toEqual([BUDGETS, CATEGORIES, RECURRING, MONTH_FILE])
    expect(body.files[MONTH_FILE]).toEqual({
      content: '{\n  "expenses": []\n}\n',
      revision: `sha:${MONTH_FILE}`,
    })
    expect(body.files[MEMBERS_FILE]).toBeUndefined()
    expect(stub.requests).toContainEqual({ method: 'GET', path: 'ledger/months' })
    // 列表响应绝不含 members.json(服务端专管);auth 校验会单独读取该文件核对停用状态
    expect(
      stub.requests.filter((request) => request.method === 'PUT' || request.method === 'DELETE'),
    ).toEqual([])
  })

  it('未认证返回 401', async () => {
    stub = githubStub()
    vi.stubGlobal('fetch', stub.impl)

    const response = await ledgerListGet({
      request: new Request(`${BASE}/api/ledger/list`),
      env: ENV,
    })

    expect(response.status).toBe(401)
    expect(await jsonOf(response)).toMatchObject({ error: 'unauthorized' })
  })
})

describe('DELETE /api/ledger/file', () => {
  const MONTH_FILE = 'ledger/months/2026-10.json'

  it('成员凭当前 sha 删除月份文件', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({
      [MONTH_FILE]: '{"expenses":[]}',
      [MEMBERS_FILE]: serializeMembers([member]),
    })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await ledgerDelete({
      request: new Request(`${BASE}/api/ledger/file`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: MONTH_FILE, sha: `sha:${MONTH_FILE}` }),
      }),
      env: ENV,
    })

    expect(response.status).toBe(200)
    expect(await jsonOf(response)).toEqual({ deleted: true })
    expect(stub.files.has(MONTH_FILE)).toBe(false)
    expect(stub.requests).toContainEqual({ method: 'DELETE', path: MONTH_FILE })
  })

  it('meta 文件不可删除(403),缺 sha 返回 400', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MEMBERS_FILE]: serializeMembers([member]) })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const meta = await ledgerDelete({
      request: new Request(`${BASE}/api/ledger/file`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: 'ledger/meta/categories.json', sha: 'sha:x' }),
      }),
      env: ENV,
    })
    expect(meta.status).toBe(403)
    expect(await jsonOf(meta)).toMatchObject({ error: 'not_deletable' })

    const noSha = await ledgerDelete({
      request: new Request(`${BASE}/api/ledger/file`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: MONTH_FILE }),
      }),
      env: ENV,
    })
    expect(noSha.status).toBe(400)
    expect(await jsonOf(noSha)).toMatchObject({ error: 'invalid_request' })
  })

  it('sha 过期时 GitHub 422 映射为 409 file_conflict', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({
      [MONTH_FILE]: '{"expenses":[]}',
      [MEMBERS_FILE]: serializeMembers([member]),
    })
    vi.stubGlobal('fetch', stub.impl)
    const token = await createSession(member, ENV.JWT_SECRET)

    const response = await ledgerDelete({
      request: new Request(`${BASE}/api/ledger/file`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: MONTH_FILE, sha: 'sha-stale' }),
      }),
      env: ENV,
    })

    expect(response.status).toBe(409)
    expect(await jsonOf(response)).toMatchObject({ error: 'file_conflict' })
  })
})
