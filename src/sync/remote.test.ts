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
