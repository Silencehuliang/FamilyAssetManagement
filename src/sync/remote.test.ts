import { describe, expect, it, vi } from 'vitest'
import type { LedgerApi } from '../api/client'
import { ApiError } from '../api/client'
import { SyncConflictError } from './endpoint'
import { createRemoteEndpoint } from './remote'

/** 组装 LedgerApi 测试替身;默认各方法返回空白数据 */
function fakeApi(overrides: Partial<LedgerApi> = {}): LedgerApi {
  return {
    setup: vi.fn(),
    login: vi.fn(),
    getMembers: vi.fn(),
    listLedgerFiles: vi.fn(async () => ({})),
    getLedgerFile: vi.fn(),
    putLedgerFile: vi.fn(async () => ({ revision: 'sha-new' })),
    deleteLedgerFile: vi.fn(async () => undefined),
    probeInitialization: vi.fn(),
    ...overrides,
  } as LedgerApi
}

describe('createRemoteEndpoint', () => {
  it('listFiles 直接透传服务端的 {content, revision}', async () => {
    const files = { 'ledger/months/2026-10.json': { content: '{}\n', revision: 'sha-1' } }
    const api = fakeApi({ listLedgerFiles: vi.fn(async () => files) })

    await expect(createRemoteEndpoint(api).listFiles()).resolves.toEqual(files)
  })

  it('putFile 以 baseRevision 作为基线 sha,返回新 revision', async () => {
    const putLedgerFile = vi.fn(async () => ({ revision: 'sha-2' }))
    const api = fakeApi({ putLedgerFile })
    const endpoint = createRemoteEndpoint(api)

    await expect(endpoint.putFile('ledger/months/2026-10.json', '{}\n', 'sha-1')).resolves.toEqual({
      revision: 'sha-2',
    })
    expect(putLedgerFile).toHaveBeenCalledWith('ledger/months/2026-10.json', '{}\n', 'sha-1')
  })

  it('服务端 file_conflict 映射为 SyncConflictError', async () => {
    const conflict = new ApiError(409, 'file_conflict', '远端文件状态已变化')
    const api = fakeApi({
      putLedgerFile: vi.fn(async () => {
        throw conflict
      }),
      deleteLedgerFile: vi.fn(async () => {
        throw conflict
      }),
    })
    const endpoint = createRemoteEndpoint(api)

    await expect(
      endpoint.putFile('ledger/months/2026-10.json', '{}', 'stale'),
    ).rejects.toBeInstanceOf(SyncConflictError)
    await expect(endpoint.deleteFile('ledger/months/2026-10.json', 'stale')).rejects.toBeInstanceOf(
      SyncConflictError,
    )
  })

  it('其他错误原样上抛(如网络错误、401)', async () => {
    const network = new ApiError(0, 'network_error', '网络连接失败')
    const api = fakeApi({
      putLedgerFile: vi.fn(async () => {
        throw network
      }),
    })

    await expect(createRemoteEndpoint(api).putFile('ledger/x.json', '{}')).rejects.toBe(network)
  })

  it('deleteFile 透传基线 revision', async () => {
    const deleteLedgerFile = vi.fn(async () => undefined)
    const endpoint = createRemoteEndpoint(fakeApi({ deleteLedgerFile }))

    await endpoint.deleteFile('ledger/months/2026-09.json', 'sha-9')

    expect(deleteLedgerFile).toHaveBeenCalledWith('ledger/months/2026-09.json', 'sha-9')
  })
})

describe('管理员专属元数据的成员端策略(评审回归)', () => {
  it('成员会话:分类/预算/标签组只拉不推,写操作本地跳过不发请求', async () => {
    const putLedgerFile = vi.fn(
      async (_path: string, _content: string, _baseRevision?: string) => ({ revision: 'sha-x' }),
    )
    const api = {
      ...fakeApi({ putLedgerFile }),
      getSession: () => ({ member: { role: 'member' } }),
    }
    const endpoint = createRemoteEndpoint(api)

    await expect(endpoint.putFile('ledger/meta/categories.json', '{}\n')).resolves.toMatchObject({
      revision: expect.any(String),
    })
    await expect(endpoint.deleteFile('ledger/meta/budgets.json')).resolves.toBeUndefined()
    // 标签组仅管理员可写:成员写入被本地跳过,否则服务端 403 会让队列永久卡死(评审修复)
    await expect(endpoint.putFile('ledger/meta/tagGroups.json', '{}\n')).resolves.toMatchObject({
      revision: expect.any(String),
    })
    await expect(endpoint.deleteFile('ledger/meta/tagGroups.json')).resolves.toBeUndefined()
    expect(putLedgerFile).not.toHaveBeenCalled()

    // 月度支出文件与标签实体不受影响,照常推送(标签全员可写)
    await endpoint.putFile('ledger/months/2026-10.json', '{}\n')
    await endpoint.putFile('ledger/meta/tags.json', '{"tags":[]}\n')
    expect(putLedgerFile).toHaveBeenCalledTimes(2)
    expect(putLedgerFile.mock.calls.map((call) => call[0])).toEqual([
      'ledger/months/2026-10.json',
      'ledger/meta/tags.json',
    ])
  })

  it('管理员会话:分类与标签组元数据照常推送', async () => {
    const putLedgerFile = vi.fn(
      async (_path: string, _content: string, _baseRevision?: string) => ({ revision: 'sha-a' }),
    )
    const api = {
      ...fakeApi({ putLedgerFile }),
      getSession: () => ({ member: { role: 'admin' } }),
    }
    const endpoint = createRemoteEndpoint(api)

    await endpoint.putFile('ledger/meta/categories.json', '{}\n')
    await endpoint.putFile('ledger/meta/tagGroups.json', '{"groups":[]}\n')
    expect(putLedgerFile).toHaveBeenCalledTimes(2)
  })
})
