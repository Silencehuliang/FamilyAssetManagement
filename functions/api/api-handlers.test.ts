import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type JwtPayload, verifyJwt } from '../../src/lib/auth/jwt'
import {
  MEMBERS_FILE,
  type MemberRecord,
  parseMembers,
  serializeMembers,
} from '../../src/lib/auth/members'
import { hashPassword } from '../../src/lib/auth/password'
import { createSession } from '../../src/lib/auth/session'
import { onRequestPost as changePasswordPost } from './auth/password'
import { onRequestGet as ledgerGet, onRequestPut as ledgerPut } from './ledger/file'
import { onRequestPost as loginPost } from './login'
import { onRequestGet as membersGet } from './members'
import { onRequestPost as resetPasswordPost } from './members/password'
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
      return Promise.resolve(
        Response.json({ content: { sha: `new-sha-${++counter}` } }, { status: 201 }),
      )
    }
    const content = files.get(path)
    if (content === undefined) {
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    return Promise.resolve(
      Response.json({ content: encodeBase64Utf8(content), encoding: 'base64', sha: `sha:${path}` }),
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

describe('GET /api/ledger/file', () => {
  const MONTH_FILE = 'ledger/months/2026-10.json'

  it('已认证成员读取账本文件', async () => {
    const member = await seededMember('xiaohong', 'pw-123456')
    stub = githubStub({ [MONTH_FILE]: '{"expenses":[]}' })
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
    stub = githubStub()
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
    stub = githubStub()
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
})
