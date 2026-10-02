import { describe, expect, it } from 'vitest'
import type { Member } from '../domain'
import { ApiClient, ApiError, isNetworkError } from './client'
import type { StorageLike, StoredSession } from './session'

const BASE = 'https://family-ledger.pages.dev'

const ADA: Member = {
  id: 'm-ada',
  username: 'ada',
  displayName: '阿达',
  role: 'admin',
  disabled: false,
  createdAt: '2026-09-01T00:00:00.000Z',
}

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}

function fakeFetch(handler: (call: Call) => Response): {
  impl: (input: string, init?: RequestInit) => Promise<Response>
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: input,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return Promise.resolve(handler(call))
  }
  return { impl, calls }
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function sessionFixture(): StoredSession {
  return { token: 'jwt-token-1', member: ADA }
}

describe('ApiClient 会话', () => {
  it('登录成功后写入 localStorage 会话,后续请求附带 Bearer', async () => {
    const storage = memoryStorage()
    const { impl, calls } = fakeFetch((call) => {
      if (call.url === `${BASE}/api/login`) return jsonResponse({ token: 'jwt-1', member: ADA })
      return jsonResponse({ members: [ADA] })
    })
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage })

    const result = await client.login({ username: 'ada', password: 'pw' })

    expect(result.member).toEqual(ADA)
    expect(client.token).toBe('jwt-1')
    expect(storage.data.get('fl.session')).toContain('jwt-1')

    await client.getMembers()
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer jwt-1')
    expect(calls[1]?.url).toBe(`${BASE}/api/members`)
  })

  it('从存储恢复会话并自动附带令牌', async () => {
    const storage = memoryStorage()
    storage.setItem('fl.session', JSON.stringify(sessionFixture()))
    const { impl, calls } = fakeFetch(() => jsonResponse({ members: [ADA] }))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage })

    await client.getMembers()

    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer jwt-token-1')
  })

  it('401 清空会话并触发 onUnauthorized', async () => {
    const storage = memoryStorage()
    storage.setItem('fl.session', JSON.stringify(sessionFixture()))
    let unauthorized = 0
    const { impl } = fakeFetch(() =>
      jsonResponse({ error: 'unauthorized', message: '会话无效或已过期' }, 401),
    )
    const client = new ApiClient({
      baseUrl: BASE,
      fetchImpl: impl,
      storage,
      onUnauthorized: () => {
        unauthorized += 1
      },
    })

    await expect(client.getMembers()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: '会话无效或已过期',
    })
    expect(client.getSession()).toBeNull()
    expect(storage.data.has('fl.session')).toBe(false)
    expect(unauthorized).toBe(1)
  })

  it('网络层失败映射为 network_error(status 0)', async () => {
    const failing = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: failing, storage: memoryStorage() })

    const error = await client.getMembers().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 0, code: 'network_error' })
    expect(isNetworkError(error)).toBe(true)
  })

  it('setup 成功后同样持久化会话', async () => {
    const storage = memoryStorage()
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({ token: 'jwt-setup', member: { ...ADA, role: 'admin' } }),
    )
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage })

    await client.setup({ username: 'ada', displayName: '阿达', password: 'root-pw-123' })

    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/api/setup` })
    expect(calls[0]?.body).toEqual({
      username: 'ada',
      displayName: '阿达',
      password: 'root-pw-123',
    })
    expect(client.token).toBe('jwt-setup')
  })
})

describe('ApiClient 账本文件', () => {
  it('listLedgerFiles 透传 files 映射', async () => {
    const files = { 'ledger/months/2026-10.json': { content: '{}\n', revision: 'sha-1' } }
    const { impl, calls } = fakeFetch(() => jsonResponse({ files }))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await expect(client.listLedgerFiles()).resolves.toEqual(files)
    expect(calls[0]?.url).toBe(`${BASE}/api/ledger/list`)
  })

  it('getLedgerFile 将 sha 映射为 revision,路径段编码', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ content: '{}', sha: 'sha-9' }))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await expect(client.getLedgerFile('ledger/months/2026-10.json')).resolves.toEqual({
      content: '{}',
      revision: 'sha-9',
    })
    expect(calls[0]?.url).toBe(
      `${BASE}/api/ledger/file?path=${encodeURIComponent('ledger/months/2026-10.json')}`,
    )
  })

  it('putLedgerFile 提交基线 sha 并返回新 revision', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ sha: 'sha-new' }))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await expect(
      client.putLedgerFile('ledger/months/2026-10.json', '{"expenses":[]}\n', 'sha-old'),
    ).resolves.toEqual({ revision: 'sha-new' })
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.body).toEqual({
      path: 'ledger/months/2026-10.json',
      content: '{"expenses":[]}\n',
      sha: 'sha-old',
    })
  })

  it('deleteLedgerFile 带基线 sha;缺基线时先取当前 sha 再删除', async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.method === 'GET') return jsonResponse({ content: '{}', sha: 'sha-current' })
      return jsonResponse({ deleted: true })
    })
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await client.deleteLedgerFile('ledger/months/2026-09.json', 'sha-known')
    await client.deleteLedgerFile('ledger/months/2026-10.json')

    expect(calls[0]).toMatchObject({ method: 'DELETE' })
    expect(calls[0]?.body).toEqual({ path: 'ledger/months/2026-09.json', sha: 'sha-known' })
    expect(calls[1]?.method).toBe('GET')
    expect(calls[2]?.body).toEqual({ path: 'ledger/months/2026-10.json', sha: 'sha-current' })
  })

  it('deleteLedgerFile 缺基线且文件已不存在时静默成功', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({ error: 'not_found', message: '账本文件不存在' }, 404),
    )
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await expect(client.deleteLedgerFile('ledger/months/2026-08.json')).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})

describe('ApiClient.probeInitialization', () => {
  it('仓库无 members.json → uninitialized', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({ error: 'members_file_missing', message: '账本尚未初始化' }, 500),
    )
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await expect(client.probeInitialization()).resolves.toBe('uninitialized')
    expect(calls[0]?.headers.get('Authorization')).toBeNull()
  })

  it('已初始化但未登录(401)→ initialized', async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({ error: 'unauthorized', message: '缺少会话凭据' }, 401),
    )
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage: memoryStorage() })

    await expect(client.probeInitialization()).resolves.toBe('initialized')
  })

  it('网络错误向上抛出,由启动流程决定降级', async () => {
    const failing = (): Promise<Response> => Promise.reject(new TypeError('offline'))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: failing, storage: memoryStorage() })

    await expect(client.probeInitialization()).rejects.toMatchObject({
      code: 'network_error',
    })
  })
})

describe('ApiClient.changePassword', () => {
  it('提交当前密码与新密码,返回更新后的成员并附带会话', async () => {
    const storage = memoryStorage()
    storage.setItem('fl.session', JSON.stringify(sessionFixture()))
    const { impl, calls } = fakeFetch(() => jsonResponse({ member: ADA }))
    const client = new ApiClient({ baseUrl: BASE, fetchImpl: impl, storage })

    await expect(
      client.changePassword({ currentPassword: 'old-pw', newPassword: 'new-pw' }),
    ).resolves.toEqual(ADA)
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/api/auth/password` })
    expect(calls[0]?.body).toEqual({ currentPassword: 'old-pw', newPassword: 'new-pw' })
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer jwt-token-1')
  })

  it('当前密码错误(401 wrong_password)不清会话、不触发 onUnauthorized', async () => {
    const storage = memoryStorage()
    storage.setItem('fl.session', JSON.stringify(sessionFixture()))
    let unauthorized = 0
    const { impl } = fakeFetch(() =>
      jsonResponse({ error: 'wrong_password', message: '当前密码错误' }, 401),
    )
    const client = new ApiClient({
      baseUrl: BASE,
      fetchImpl: impl,
      storage,
      onUnauthorized: () => {
        unauthorized += 1
      },
    })

    await expect(
      client.changePassword({ currentPassword: 'bad', newPassword: 'new-pw' }),
    ).rejects.toMatchObject({ status: 401, code: 'wrong_password', message: '当前密码错误' })
    expect(client.getSession()).not.toBeNull()
    expect(storage.data.has('fl.session')).toBe(true)
    expect(unauthorized).toBe(0)
  })
})

describe('未登录探针的 401(评审回归)', () => {
  it('不触发会话过期通知、不清空会话', async () => {
    const storage = memoryStorage()
    let unauthorized = 0
    const { impl } = fakeFetch(() =>
      jsonResponse({ error: 'unauthorized', message: '缺少会话凭据' }, 401),
    )
    const client = new ApiClient({
      baseUrl: BASE,
      fetchImpl: impl,
      storage,
      onUnauthorized: () => {
        unauthorized += 1
      },
    })

    await expect(client.probeInitialization()).resolves.toBe('initialized')
    expect(unauthorized).toBe(0)
  })
})

describe('changePassword 的会话处理(评审回归)', () => {
  it('会话过期(unauthorized)时仍然清会话并通知', async () => {
    const storage = memoryStorage()
    storage.setItem('fl.session', JSON.stringify(sessionFixture()))
    let unauthorized = 0
    const { impl } = fakeFetch(() =>
      jsonResponse({ error: 'unauthorized', message: '会话无效或已过期' }, 401),
    )
    const client = new ApiClient({
      baseUrl: BASE,
      fetchImpl: impl,
      storage,
      onUnauthorized: () => {
        unauthorized += 1
      },
    })

    await expect(
      client.changePassword({ currentPassword: 'a-123456', newPassword: 'b-123456' }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(client.getSession()).toBeNull()
    expect(unauthorized).toBe(1)
  })
})
