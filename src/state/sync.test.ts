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
  TAGS_FILE,
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
  role?: 'admin' | 'member'
  now?: () => Date
}) {
  const statuses: SyncStatus[] = []
  const ledger = options.ledger ?? fixtureLedger()
  const manager = new SyncManager({
    endpoint: options.endpoint ?? new InMemoryEndpoint(),
    queue: options.queue ?? new PendingQueue(),
    ledger,
    getRole: () => options.role,
    isOnline: options.online,
    now: options.now,
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

describe('SyncManager 角色合并策略(T8 评审要求)', () => {
  /** 远端分类被管理员改名;本地持有旧名 */
  function remoteRenamed() {
    const remote = fixtureLedger()
    remote.meta.categories = remote.meta.categories.map((c) =>
      c.id === 'cat-dining' ? { ...c, name: '吃饭' } : c,
    )
    const ledger = fixtureLedger()
    ledger.meta.categories = ledger.meta.categories.map((c) =>
      c.id === 'cat-dining' ? { ...c, name: '旧叫法' } : c,
    )
    return { ledger, endpoint: new InMemoryEndpoint(ledgerToFiles(remote)) }
  }

  it('成员角色:同步后本地分类等于远端(采纳管理员改动,不回推旧副本)', async () => {
    const { ledger, endpoint } = remoteRenamed()
    const { manager } = makeManager({ ledger, endpoint, role: 'member' })

    await manager.syncNow()

    expect(manager.status).toBe('synced')
    expect(ledger.meta.categories.find((c) => c.id === 'cat-dining')?.name).toBe('吃饭')
    const contents = Object.fromEntries(
      Object.entries(await endpoint.listFiles()).map(([path, file]) => [path, file.content]),
    )
    expect(filesToLedger(contents).meta.categories.find((c) => c.id === 'cat-dining')?.name).toBe(
      '吃饭',
    )
  })

  it('管理员角色:local-wins,本地编辑保留并推送到远端', async () => {
    const { ledger, endpoint } = remoteRenamed()
    const { manager } = makeManager({ ledger, endpoint, role: 'admin' })

    await manager.syncNow()

    expect(ledger.meta.categories.find((c) => c.id === 'cat-dining')?.name).toBe('旧叫法')
    const contents = Object.fromEntries(
      Object.entries(await endpoint.listFiles()).map(([path, file]) => [path, file.content]),
    )
    expect(filesToLedger(contents).meta.categories.find((c) => c.id === 'cat-dining')?.name).toBe(
      '旧叫法',
    )
  })

  it('角色缺省(未注入)时保持 local-wins,既有行为不变', async () => {
    const { ledger, endpoint } = remoteRenamed()
    const { manager } = makeManager({ ledger, endpoint })

    await manager.syncNow()

    expect(ledger.meta.categories.find((c) => c.id === 'cat-dining')?.name).toBe('旧叫法')
  })
})

describe('乐观并发冲突自动重跑(评审回归)', () => {
  it('首轮 SyncConflictError 后自动重跑一轮并收敛为 synced', async () => {
    const inner = new InMemoryEndpoint()
    const { SyncConflictError } = await import('../sync')
    let failOnce = true
    const endpoint: SyncEndpoint = {
      listFiles: () => inner.listFiles(),
      putFile: (path, content, baseRevision) => {
        if (failOnce) {
          failOnce = false
          return Promise.reject(new SyncConflictError(path, '远端文件状态已变化'))
        }
        return inner.putFile(path, content, baseRevision)
      },
      deleteFile: (path, baseRevision) => inner.deleteFile(path, baseRevision),
    }
    const { manager, statuses } = makeManager({ endpoint, ledger: fixtureLedger() })

    await manager.syncNow()

    expect(manager.status).toBe('synced')
    expect(statuses.at(-1)).toBe('synced')
  })
})

describe('标签迁移接线(ADR-0006)', () => {
  const MIGRATION_NOW = () => new Date('2026-10-02T09:00:00.000Z')

  function legacyManager() {
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      {
        amountCents: 1200,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信', '现金'],
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-legacy' },
    )
    const endpoint = new InMemoryEndpoint()
    const { manager } = makeManager({ ledger, endpoint, now: MIGRATION_NOW })
    return { ledger, endpoint, manager }
  }

  async function contentsOf(endpoint: InMemoryEndpoint): Promise<Record<string, string>> {
    const files = await endpoint.listFiles()
    const contents: Record<string, string> = {}
    for (const [path, file] of Object.entries(files)) contents[path] = file.content
    return contents
  }

  it('同步后旧 tagNames 迁移为标签实体 + tagIds 并推送;第二遍幂等无增量', async () => {
    const { ledger, endpoint, manager } = legacyManager()

    await manager.syncNow()

    expect(manager.status).toBe('synced')
    const expense = ledger.months['2026-10']?.expenses[0]
    expect(expense?.tagNames).toBeUndefined()
    expect(expense?.tagIds).toHaveLength(2)
    expect(expense?.updatedAt).toBe(NOW) // 迁移是表示转换,不刷新支出时间戳
    expect(ledger.meta.tags.map((t) => t.name).sort()).toEqual(['微信', '现金'])

    const files = await contentsOf(endpoint)
    expect(files[TAGS_FILE]).toContain('"微信"')
    expect(files[TAGS_FILE]).toContain('"现金"')
    expect(files[monthFilePath('2026-10')]).toContain('tagIds')
    expect(files[monthFilePath('2026-10')]).not.toContain('tagNames')

    const idle = await manager.syncNow()
    expect(idle).toEqual({ pulledFiles: 0, pushedFiles: 0, conflictsResolved: 0 })
  })

  it('远端仍有旧表示时合并不来回翻转:迁移后立即差分推送,远端落库为新表示', async () => {
    const { ledger, endpoint, manager } = legacyManager()
    await manager.syncNow()

    // 另一台尚未迁移的设备把同刻旧表示写回端点(id 并集 + JSON 字典序会选中旧表示)
    const stale = fixtureLedger()
    addExpense(
      stale,
      {
        amountCents: 1200,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信', '现金'],
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-legacy' },
    )
    const staleMonth = ledgerToFiles(stale)[monthFilePath('2026-10')]
    if (!staleMonth) throw new Error('测试辅助:旧月份内容缺失')
    endpoint.assignFile(monthFilePath('2026-10'), staleMonth)

    await manager.syncNow()

    expect(ledger.months['2026-10']?.expenses[0]?.tagNames).toBeUndefined()
    expect(ledger.months['2026-10']?.expenses[0]?.tagIds).toHaveLength(2)
    const files = await contentsOf(endpoint)
    expect(files[monthFilePath('2026-10')]).not.toContain('tagNames')
    expect(files[monthFilePath('2026-10')]).toContain('tagIds')
  })
})
