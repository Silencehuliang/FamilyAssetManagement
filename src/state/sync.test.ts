import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { addExpense, DEFAULT_CATEGORIES, deleteExpense } from '../domain'
import { fixtureLedger, LUNCH_CATEGORY, NOW, XIAOHONG } from '../domain/fixtures'
import type { RemoteFile, SyncEndpoint } from '../sync'
import {
  CATEGORIES_FILE,
  filesToLedger,
  InMemoryEndpoint,
  ledgerToFiles,
  monthFilePath,
  PendingQueue,
} from '../sync'
import { SyncManager, type SyncStatus } from './sync'

/** 可切换离线、可记录调用的端点包装 */
class ToggleEndpoint implements SyncEndpoint {
  online = true
  listCalls = 0

  constructor(private readonly inner: SyncEndpoint) {}

  listFiles(): Promise<Record<string, RemoteFile>> {
    this.listCalls += 1
    if (!this.online) return Promise.reject(new ApiError(0, 'network_error', '网络连接失败'))
    return this.inner.listFiles()
  }

  putFile(path: string, content: string, baseRevision?: string) {
    if (!this.online) return Promise.reject(new ApiError(0, 'network_error', '网络连接失败'))
    return this.inner.putFile(path, content, baseRevision)
  }

  deleteFile(path: string, baseRevision?: string): Promise<void> {
    if (!this.online) return Promise.reject(new ApiError(0, 'network_error', '网络连接失败'))
    return this.inner.deleteFile(path, baseRevision)
  }
}

function makeManager(options: {
  ledger?: ReturnType<typeof fixtureLedger>
  endpoint?: SyncEndpoint
  queue?: PendingQueue
  online?: () => boolean
}) {
  const statuses: SyncStatus[] = []
  const ledger = options.ledger ?? fixtureLedger()
  const manager = new SyncManager({
    endpoint: options.endpoint ?? new InMemoryEndpoint(),
    queue: options.queue ?? new PendingQueue(),
    ledger,
    isOnline: options.online,
    onStatus: (status) => statuses.push(status),
  })
  return { manager, ledger, statuses }
}

describe('SyncManager 状态机', () => {
  it('离线时置 offline 且不发请求', async () => {
    const endpoint = new ToggleEndpoint(new InMemoryEndpoint())
    const { manager, statuses } = makeManager({ endpoint, online: () => false })

    await expect(manager.syncNow()).resolves.toBeNull()

    expect(manager.status).toBe('offline')
    expect(endpoint.listCalls).toBe(0)
    expect(statuses).toEqual(['offline'])
  })

  it('在线成功:syncing → synced,并写穿回调被调用', async () => {
    let persisted = 0
    const statuses: SyncStatus[] = []
    const ledger = fixtureLedger()
    const manager = new SyncManager({
      endpoint: new InMemoryEndpoint(),
      queue: new PendingQueue(),
      ledger,
      onStatus: (status) => statuses.push(status),
      onSynced: () => {
        persisted += 1
      },
    })

    await manager.syncNow()

    expect(manager.status).toBe('synced')
    expect(persisted).toBe(1)
    expect(statuses).toEqual(['syncing', 'synced'])
  })

  it('网络失败置 offline;服务端 5xx 置 error 并保留错误信息', async () => {
    const failingEndpoint: SyncEndpoint = {
      listFiles: () => Promise.reject(new ApiError(0, 'network_error', '网络连接失败')),
      putFile: () => Promise.reject(new Error('unused')),
      deleteFile: () => Promise.reject(new Error('unused')),
    }
    const offline = makeManager({ endpoint: failingEndpoint })
    await offline.manager.syncNow()
    expect(offline.manager.status).toBe('offline')

    const serverError: SyncEndpoint = {
      listFiles: () => Promise.reject(new ApiError(502, 'github_error', 'GitHub API 返回 502')),
      putFile: () => Promise.reject(new Error('unused')),
      deleteFile: () => Promise.reject(new Error('unused')),
    }
    const errored = makeManager({ endpoint: serverError })
    await errored.manager.syncNow()
    expect(errored.manager.status).toBe('error')
    expect(errored.manager.error).toBe('GitHub API 返回 502')
  })

  it('markOffline 在同步中不打断当前轮', async () => {
    const { manager } = makeManager({})
    manager.markOffline()
    expect(manager.status).toBe('offline')
  })
})

describe('SyncManager 首次播种与离线删除回放', () => {
  it('空远端 + 空本地:播种 DEFAULT_CATEGORIES 并推送到端点', async () => {
    const ledger = fixtureLedger()
    ledger.meta.categories = []
    const endpoint = new InMemoryEndpoint()
    const { manager } = makeManager({ ledger, endpoint })

    await manager.syncNow()

    expect(manager.status).toBe('synced')
    // 同步引擎输出规范化:分类按 id 排序(集合等价于默认分类)
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
    expect([...ledger.meta.categories].sort(byId)).toEqual([...DEFAULT_CATEGORIES].sort(byId))
    const remoteContents = Object.fromEntries(
      Object.entries(await endpoint.listFiles()).map(([path, file]) => [path, file.content]),
    )
    expect([...filesToLedger(remoteContents).meta.categories].sort(byId)).toEqual(
      [...DEFAULT_CATEGORIES].sort(byId),
    )
  })

  it('远端已有 categories.json(即使为空)时不播种本地默认分类', async () => {
    const ledger = fixtureLedger()
    ledger.meta.categories = []
    const endpoint = new InMemoryEndpoint({ [CATEGORIES_FILE]: '{"categories": []}\n' })
    const { manager } = makeManager({ ledger, endpoint })

    await manager.syncNow()

    expect(ledger.meta.categories).toEqual([])
    const remoteContents = Object.fromEntries(
      Object.entries(await endpoint.listFiles()).map(([path, file]) => [path, file.content]),
    )
    expect(filesToLedger(remoteContents).meta.categories).toEqual([])
  })

  it('离线登记的删除在恢复后回放:远端月份文件消失,队列清空', async () => {
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      { amountCents: 1200, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )
    const remote = fixtureLedger()
    addExpense(
      remote,
      { amountCents: 1200, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )
    const endpoint = new ToggleEndpoint(new InMemoryEndpoint(ledgerToFiles(remote)))
    const queue = new PendingQueue()
    let online = false
    const { manager } = makeManager({ ledger, endpoint, queue, online: () => online })

    // 离线:本地删除 + 登记墓碑
    deleteExpense(ledger, 'e-1', { actor: XIAOHONG, now: NOW, newId: 'unused' })
    queue.record({ type: 'delete-expense', id: 'e-1', month: '2026-10', deletedAt: NOW })

    await manager.syncNow()
    expect(manager.status).toBe('offline')
    expect(queue.size).toBe(1)
    expect((await endpoint.listFiles())[monthFilePath('2026-10')]).toBeDefined()

    // 恢复联网:队列回放,远端文件删除
    online = true
    await manager.syncNow()

    expect(manager.status).toBe('synced')
    expect(queue.size).toBe(0)
    expect((await endpoint.listFiles())[monthFilePath('2026-10')]).toBeUndefined()
  })
})
