import { describe, expect, it } from 'vitest'
import type { Expense, RecurringExpense } from '../domain'
import { addExpense, createEmptyLedger, deleteCategory } from '../domain'
import { ADMIN, DINNER_CATEGORY, fixtureLedger, LUNCH_CATEGORY, XIAOHONG } from '../domain/fixtures'
import type { PutResult, RemoteFile, SyncEndpoint } from './endpoint'
import { sync } from './engine'
import { filesToLedger, ledgerToFiles, monthFilePath } from './files'
import { InMemoryEndpoint } from './in-memory'
import { PendingQueue, replay } from './queue'

/** 成员数据不属同步文件集(服务端专管):比较账本内容时忽略 members */
function sansMembers<L extends { meta: { members: unknown[] } }>(l: L): L {
  return { ...l, meta: { ...l.meta, members: [] } }
}
const T0 = '2026-10-02T08:00:00.000Z'

function expense(
  id: string,
  date: string,
  updatedAt: string,
  extra: Partial<Expense> = {},
): Expense {
  return {
    id,
    amountCents: 1000,
    date,
    categoryId: 'cat-x',
    tagIds: [],
    memberId: 'm-1',
    recordedBy: 'm-1',
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  }
}

function recurring(
  id: string,
  updatedAt: string,
  extra: Partial<RecurringExpense> = {},
): RecurringExpense {
  return {
    id,
    amountCents: 3000,
    categoryId: 'cat-x',
    tagNames: [],
    memberId: 'm-1',
    frequency: 'monthly',
    startDate: '2026-10-01',
    enabled: true,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  }
}

/** 最小账本:空 meta + 按月份分组的支出 */
function ledgerWith(expenses: Expense[]): ReturnType<typeof createEmptyLedger> {
  const ledger = createEmptyLedger()
  for (const item of expenses) {
    const month = item.date.slice(0, 7)
    const bucket = ledger.months[month]?.expenses ?? []
    bucket.push(item)
    ledger.months[month] = { expenses: bucket }
  }
  return ledger
}

async function contentsOf(endpoint: SyncEndpoint): Promise<Record<string, string>> {
  const files = await endpoint.listFiles()
  const contents: Record<string, string> = {}
  for (const [path, file] of Object.entries(files)) contents[path] = file.content
  return contents
}

/** 记录 putFile 调用的端点包装(验证增量推送) */
class SpyEndpoint implements SyncEndpoint {
  readonly putPaths: string[] = []

  constructor(private readonly inner: SyncEndpoint) {}

  listFiles(): Promise<Record<string, RemoteFile>> {
    return this.inner.listFiles()
  }

  async putFile(path: string, content: string, baseRevision?: string): Promise<PutResult> {
    this.putPaths.push(path)
    return this.inner.putFile(path, content, baseRevision)
  }

  deleteFile(path: string, baseRevision?: string): Promise<void> {
    return this.inner.deleteFile(path, baseRevision)
  }
}

describe('sync', () => {
  it('空账本同步到空端点:恰好 5 个 meta 文件(members.json 服务端专管),无月份文件', async () => {
    const local = createEmptyLedger()
    const endpoint = new InMemoryEndpoint()

    const result = await sync(local, endpoint)

    expect(result).toEqual({ pulledFiles: 0, pushedFiles: 5, conflictsResolved: 0 })
    const files = await endpoint.listFiles()
    expect(Object.keys(files).sort()).toEqual(
      [
        'ledger/meta/budgets.json',
        'ledger/meta/categories.json',
        'ledger/meta/recurring.json',
        'ledger/meta/tagGroups.json',
        'ledger/meta/tags.json',
      ].sort(),
    )
  })

  it('从端点拉取月份文件到空账本', async () => {
    const remote = ledgerWith([expense('e-1', '2026-10-02', T0)])
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remote))
    const local = createEmptyLedger()

    const result = await sync(local, endpoint)

    expect(result.pulledFiles).toBe(1)
    expect(result.pushedFiles).toBe(0)
    expect(local.months['2026-10']?.expenses).toEqual(remote.months['2026-10']?.expenses)
  })

  it('同一支出双方都有:updatedAt 晚者胜,冲突计数为 1', async () => {
    const local = ledgerWith([
      expense('e-1', '2026-10-02', '2026-10-02T08:00:00.000Z', { amountCents: 1000 }),
    ])
    const remote = ledgerWith([
      expense('e-1', '2026-10-02', '2026-10-02T09:00:00.000Z', { amountCents: 2000 }),
    ])
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remote))

    const result = await sync(local, endpoint)

    expect(result.conflictsResolved).toBe(1)
    expect(local.months['2026-10']?.expenses[0]?.amountCents).toBe(2000)
    expect(result.pushedFiles).toBe(0)
  })

  it('周期支出同样按 updatedAt 后写胜出', async () => {
    const local = ledgerWith([])
    local.meta.recurring = [recurring('r-1', '2026-10-01T08:00:00.000Z')]
    const remote = ledgerWith([])
    remote.meta.recurring = [recurring('r-1', '2026-10-01T09:00:00.000Z', { enabled: false })]
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remote))

    const result = await sync(local, endpoint)

    expect(result.conflictsResolved).toBe(1)
    expect(local.meta.recurring[0]?.enabled).toBe(false)
  })

  it('同刻冲突:与合并方向无关,双方收敛到同一胜者', async () => {
    const x = expense('e-1', '2026-10-02', T0, { note: '甲' })
    const y = expense('e-1', '2026-10-02', T0, { note: '乙' })

    const fromX = ledgerWith([x])
    const resultX = await sync(fromX, new InMemoryEndpoint(ledgerToFiles(ledgerWith([y]))))
    const fromY = ledgerWith([y])
    const resultY = await sync(fromY, new InMemoryEndpoint(ledgerToFiles(ledgerWith([x]))))

    expect(resultX.conflictsResolved).toBe(1)
    expect(resultY.conflictsResolved).toBe(1)
    const winnerX = fromX.months['2026-10']?.expenses[0]?.note
    const winnerY = fromY.months['2026-10']?.expenses[0]?.note
    expect(winnerX).toBeDefined()
    expect(winnerX).toBe(winnerY)
    // 确定规则:序列化 JSON 字典序大者胜
    expect(winnerX).toBe(JSON.stringify(x) > JSON.stringify(y) ? '甲' : '乙')
  })

  it('成员数据不随文件同步(服务端专管);分类/预算:远端只补缺,双方都有保留本地(v1 规则)', async () => {
    const memberLocal = {
      id: 'm-1',
      username: 'aming',
      displayName: '本地名',
      role: 'admin' as const,
      disabled: false,
      createdAt: T0,
    }
    const budgetSep = { categoryCents: { 'c-9': 500 } }
    const budgetOct = { totalCents: 100000, categoryCents: {} }
    const budgetOctRemote = { totalCents: 999, categoryCents: {} }

    const local = createEmptyLedger()
    local.meta.members = [memberLocal]
    local.meta.categories = [{ id: 'c-1', name: '本地分类', sortOrder: 1 }]
    local.meta.budgets = { '2026-10': budgetOct }

    const remote = createEmptyLedger()
    remote.meta.members = [{ ...memberLocal, displayName: '远端名', id: 'm-2' }]
    remote.meta.categories = [
      { id: 'c-1', name: '远端分类', sortOrder: 5 },
      { id: 'c-2', name: '新增分类', sortOrder: 2 },
    ]
    remote.meta.budgets = { '2026-09': budgetSep, '2026-10': budgetOctRemote }

    const result = await sync(local, new InMemoryEndpoint(ledgerToFiles(remote)))

    expect(result.conflictsResolved).toBe(0)
    // 远端文件不含成员数据,本地成员列表保持原样(由 GET /api/members 填充)
    expect(local.meta.members).toEqual([memberLocal])
    expect(local.meta.categories).toEqual([
      { id: 'c-1', name: '本地分类', sortOrder: 1 },
      { id: 'c-2', name: '新增分类', sortOrder: 2 },
    ])
    expect(local.meta.budgets).toEqual({ '2026-09': budgetSep, '2026-10': budgetOct })
  })

  it('增量:只有内容变化的文件被推送', async () => {
    const local = ledgerWith([expense('e-1', '2026-10-02', T0)])
    const shared = new InMemoryEndpoint()
    const first = await sync(local, shared)
    expect(first.pushedFiles).toBe(6) // 1 个月份文件 + 5 个 meta

    const month = local.months['2026-10']
    if (!month) throw new Error('2026-10 应存在')
    month.expenses.push(expense('e-2', '2026-10-03', '2026-10-02T09:00:00.000Z'))

    const spy = new SpyEndpoint(shared)
    const result = await sync(local, spy)

    expect(result.pulledFiles).toBe(0)
    expect(result.pushedFiles).toBe(1)
    expect(spy.putPaths).toEqual([monthFilePath('2026-10')])
  })

  it('支出改期跨月:合并后按日期重新归档,旧月份从本地消失', async () => {
    const moved = expense('e-1', '2026-10-05', '2026-10-05T08:00:00.000Z', { amountCents: 2000 })
    const local = ledgerWith([expense('e-1', '2026-09-28', '2026-10-01T08:00:00.000Z')])
    // 另一台设备把 e-1 改期到 10 月并同步:端点上旧月文件已随之消失
    const remoteFiles = ledgerToFiles(ledgerWith([]))
    const movedFiles = ledgerToFiles(ledgerWith([moved]))
    const movedContent = movedFiles[monthFilePath('2026-10')]
    if (!movedContent) throw new Error('测试辅助:2026-10 月份内容缺失')
    remoteFiles[monthFilePath('2026-10')] = movedContent
    const endpoint = new InMemoryEndpoint(remoteFiles)

    const result = await sync(local, endpoint)

    expect(result.pulledFiles).toBe(1)
    expect(result.pushedFiles).toBe(0)
    expect(Object.keys(local.months)).toEqual(['2026-10'])
    expect(local.months['2026-10']?.expenses[0]?.updatedAt).toBe('2026-10-05T08:00:00.000Z')
  })

  it('端点上内容为空支出的月份文件会在合并后被删除', async () => {
    const local = ledgerWith([])
    const endpoint = new InMemoryEndpoint({
      ...ledgerToFiles(local),
      [monthFilePath('2026-09')]: '{\n  "expenses": []\n}\n',
    })

    const result = await sync(local, endpoint)

    expect(result.pushedFiles).toBe(1)
    const files = await endpoint.listFiles()
    expect(files[monthFilePath('2026-09')]).toBeUndefined()
  })

  it('两台设备经共享端点收敛,冲突编辑的 LWW 胜者一致', async () => {
    const shared = new InMemoryEndpoint()
    const a = fixtureLedger()
    const b = fixtureLedger()
    const ctx = (now: string, newId: string) => ({ actor: XIAOHONG, now, newId })

    // 设备 A:首次同步,记两笔(第二笔暂未同步)
    await sync(a, shared)
    addExpense(
      a,
      { amountCents: 2500, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      ctx('2026-10-02T09:00:00.000Z', 'e-1'),
    )
    await sync(a, shared)
    addExpense(
      a,
      { amountCents: 1800, date: '2026-10-03', categoryId: LUNCH_CATEGORY },
      ctx('2026-10-03T08:00:00.000Z', 'e-2'),
    )

    // 设备 B:拉到 e-1(meta 可能因规范化排序一并更新),记一笔,推上去
    const bFirst = await sync(b, shared)
    expect(bFirst.pulledFiles).toBeGreaterThanOrEqual(1)
    expect(b.months['2026-10']?.expenses.map((e) => e.id)).toEqual(['e-1'])
    addExpense(
      b,
      { amountCents: 9900, date: '2026-10-02', categoryId: DINNER_CATEGORY },
      ctx('2026-10-02T11:00:00.000Z', 'e-3'),
    )
    await sync(b, shared)

    // 各再同步一轮:两台设备与端点三方一致
    await sync(a, shared)
    await sync(b, shared)
    expect(a).toEqual(b)
    expect(sansMembers(filesToLedger(await contentsOf(shared)))).toEqual(sansMembers(a))

    // 幂等:完全收敛后再同步,无任何增量
    const idle = await sync(a, shared)
    expect(idle).toEqual({ pulledFiles: 0, pushedFiles: 0, conflictsResolved: 0 })

    // 冲突轮:双方改同一笔 e-1,B 的时间戳更晚
    const aExpense = a.months['2026-10']?.expenses.find((e) => e.id === 'e-1')
    const bExpense = b.months['2026-10']?.expenses.find((e) => e.id === 'e-1')
    if (!aExpense || !bExpense) throw new Error('e-1 应同时存在于两台设备')
    aExpense.amountCents = 2600
    aExpense.updatedAt = '2026-10-04T09:00:00.000Z'
    bExpense.amountCents = 2800
    bExpense.updatedAt = '2026-10-04T10:00:00.000Z'

    await sync(a, shared)
    const bConflict = await sync(b, shared)
    expect(bConflict.conflictsResolved).toBe(1)
    const aFinal = await sync(a, shared)

    expect(a).toEqual(b)
    expect(a.months['2026-10']?.expenses.find((e) => e.id === 'e-1')?.amountCents).toBe(2800)
    expect(aFinal.pushedFiles).toBe(0)
    expect(aFinal.conflictsResolved).toBe(1)
  })
})

describe('adminFilesPolicy(成员端采纳管理员维护的分类/预算)', () => {
  const CATEGORIES = [
    { id: 'c-1', name: '管理员改名', sortOrder: 1 },
    { id: 'c-2', name: '管理员新增', sortOrder: 2 },
  ]
  const BUDGETS = { '2026-10': { totalCents: 500000, categoryCents: {} } }

  /** 本地持有旧分类/旧预算(成员设备停更一段时间) */
  function staleLocal(): ReturnType<typeof createEmptyLedger> {
    const local = createEmptyLedger()
    local.meta.categories = [{ id: 'c-1', name: '本地旧名', sortOrder: 9 }]
    local.meta.budgets = { '2026-10': { totalCents: 1, categoryCents: {} } }
    return local
  }

  function remoteWithAdminFiles(): ReturnType<typeof createEmptyLedger> {
    const remote = createEmptyLedger()
    remote.meta.categories = structuredClone(CATEGORIES)
    remote.meta.budgets = structuredClone(BUDGETS)
    return remote
  }

  it('remote-wins:采用远端分类与预算,本地旧副本不回推', async () => {
    const local = staleLocal()
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remoteWithAdminFiles()))

    const result = await sync(local, endpoint, { adminFilesPolicy: 'remote-wins' })

    expect(local.meta.categories).toEqual(CATEGORIES)
    expect(local.meta.budgets).toEqual(BUDGETS)
    expect(result.pulledFiles).toBe(2) // categories + budgets
    expect(result.pushedFiles).toBe(0)
    const contents = await contentsOf(endpoint)
    expect(filesToLedger(contents).meta.categories).toEqual(CATEGORIES)
    expect(filesToLedger(contents).meta.budgets).toEqual(BUDGETS)
  })

  it('remote-wins:远端缺分类/预算文件时保留本地(空远端不清空)', async () => {
    const local = staleLocal()
    const endpoint = new InMemoryEndpoint()

    await sync(local, endpoint, { adminFilesPolicy: 'remote-wins' })

    expect(local.meta.categories).toEqual([{ id: 'c-1', name: '本地旧名', sortOrder: 9 }])
    expect(local.meta.budgets).toEqual({ '2026-10': { totalCents: 1, categoryCents: {} } })
  })

  it('local-wins(管理员端):本地编辑保留并推送,远端被更新', async () => {
    const local = staleLocal()
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remoteWithAdminFiles()))

    const result = await sync(local, endpoint, { adminFilesPolicy: 'local-wins' })

    expect(local.meta.categories).toEqual([
      { id: 'c-1', name: '本地旧名', sortOrder: 9 },
      { id: 'c-2', name: '管理员新增', sortOrder: 2 },
    ])
    // 本地已有的月份预算保留,远端独有月份补入
    expect(local.meta.budgets).toEqual({ '2026-10': { totalCents: 1, categoryCents: {} } })
    expect(result.pushedFiles).toBe(2) // categories + budgets
    const contents = await contentsOf(endpoint)
    expect(filesToLedger(contents).meta.categories.find((c) => c.id === 'c-1')?.name).toBe(
      '本地旧名',
    )
  })

  it('不传 options 等价于 local-wins(默认行为不变)', async () => {
    const local = staleLocal()
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remoteWithAdminFiles()))

    await sync(local, endpoint)

    expect(local.meta.categories.find((c) => c.id === 'c-1')?.name).toBe('本地旧名')
    expect(local.meta.budgets).toEqual({ '2026-10': { totalCents: 1, categoryCents: {} } })
  })
})

describe('分类迁移的跨设备传播(评审回归)', () => {
  it('迁移刷新 updatedAt,持有旧副本的设备同步后采纳迁移结果而非回退', async () => {
    const a = fixtureLedger()
    addExpense(
      a,
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: T0, newId: 'e-mig' },
    )
    const shared = new InMemoryEndpoint()
    await sync(a, shared)

    // 成员 B 的本地副本:迁移发生前的状态
    const memberB = filesToLedger(await contentsOf(shared))

    // 管理员 A 迁移午餐 → 晚餐并删除午餐(时间戳晚于 T0);删除经离线队列登记后回放(生产路径)
    deleteCategory(a, ADMIN, LUNCH_CATEGORY, DINNER_CATEGORY, '2026-11-01T00:00:00.000Z')
    const queue = new PendingQueue()
    queue.record({ type: 'delete-category', id: LUNCH_CATEGORY })
    await replay(queue, a, shared)

    // 成员 B 同步:支出按新 updatedAt 采纳,分类采用远端
    await sync(memberB, shared, { adminFilesPolicy: 'remote-wins' })

    expect(memberB.months['2026-10']?.expenses[0]?.categoryId).toBe(DINNER_CATEGORY)
    expect(memberB.meta.categories.some((c) => c.id === LUNCH_CATEGORY)).toBe(false)
  })
})

describe('标签与标签组的合并(ADR-0006)', () => {
  it('标签双方可写:按 id 并集、updatedAt 后写胜出(成员端 remote-wins 同样生效)', async () => {
    const local = createEmptyLedger()
    local.meta.tags = [
      { id: 'tag-a', name: '甲(本地)', updatedAt: '2026-10-02T09:00:00.000Z' },
      { id: 'tag-b', name: '乙', updatedAt: '2026-10-01T00:00:00.000Z' },
    ]
    const remote = createEmptyLedger()
    remote.meta.tags = [
      { id: 'tag-a', name: '甲(远端)', updatedAt: '2026-10-02T08:00:00.000Z' },
      { id: 'tag-c', name: '丙', updatedAt: '2026-10-01T00:00:00.000Z' },
    ]
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remote))

    const result = await sync(local, endpoint, { adminFilesPolicy: 'remote-wins' })

    expect(result.conflictsResolved).toBe(1)
    expect(local.meta.tags).toEqual([
      { id: 'tag-a', name: '甲(本地)', updatedAt: '2026-10-02T09:00:00.000Z' },
      { id: 'tag-b', name: '乙', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'tag-c', name: '丙', updatedAt: '2026-10-01T00:00:00.000Z' },
    ])
    // 合并结果推回端点(标签不随 adminFilesPolicy 走文件级 remote-wins)
    expect(filesToLedger(await contentsOf(endpoint)).meta.tags).toEqual(local.meta.tags)
  })

  it('标签组:成员端 remote-wins 采纳管理员的组,不回推本地旧副本', async () => {
    const local = createEmptyLedger()
    local.meta.tagGroups = [{ id: 'g-1', name: '本地旧名', color: 'gray', tagIds: [] }]
    const admin = createEmptyLedger()
    admin.meta.tagGroups = [
      { id: 'g-1', name: '管理员命名', color: 'blue', tagIds: [], singleSelect: true },
      { id: 'g-2', name: '管理员新增', color: 'red', tagIds: [] },
    ]
    const endpoint = new InMemoryEndpoint(ledgerToFiles(admin))

    const result = await sync(local, endpoint, { adminFilesPolicy: 'remote-wins' })

    expect(local.meta.tagGroups).toEqual(admin.meta.tagGroups)
    expect(result.pushedFiles).toBe(0)
  })

  it('标签组:管理员端 local-wins 保留本地编辑并补入远端新增', async () => {
    const local = createEmptyLedger()
    local.meta.tagGroups = [{ id: 'g-1', name: '本地旧名', color: 'gray', tagIds: [] }]
    const remote = createEmptyLedger()
    remote.meta.tagGroups = [
      { id: 'g-1', name: '远端的名', color: 'blue', tagIds: [] },
      { id: 'g-2', name: '远端新增', color: 'red', tagIds: [] },
    ]
    const endpoint = new InMemoryEndpoint(ledgerToFiles(remote))

    const result = await sync(local, endpoint)

    expect(local.meta.tagGroups).toEqual([
      { id: 'g-1', name: '本地旧名', color: 'gray', tagIds: [] },
      { id: 'g-2', name: '远端新增', color: 'red', tagIds: [] },
    ])
    const pushed = filesToLedger(await contentsOf(endpoint)).meta.tagGroups
    expect(pushed.find((g) => g.id === 'g-1')?.name).toBe('本地旧名')
    expect(result.pushedFiles).toBeGreaterThan(0)
  })
})
