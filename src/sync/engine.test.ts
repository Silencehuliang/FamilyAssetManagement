import { describe, expect, it } from 'vitest'
import type { Expense, RecurringExpense } from '../domain'
import { addExpense, createEmptyLedger } from '../domain'
import { DINNER_CATEGORY, fixtureLedger, LUNCH_CATEGORY, XIAOHONG } from '../domain/fixtures'
import type { PutResult, RemoteFile, SyncEndpoint } from './endpoint'
import { sync } from './engine'
import { filesToLedger, ledgerToFiles, monthFilePath } from './files'
import { InMemoryEndpoint } from './in-memory'

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
    tagNames: [],
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
  it('空账本同步到空端点:恰好 4 个 meta 文件,无月份文件', async () => {
    const local = createEmptyLedger()
    const endpoint = new InMemoryEndpoint()

    const result = await sync(local, endpoint)

    expect(result).toEqual({ pulledFiles: 0, pushedFiles: 4, conflictsResolved: 0 })
    const files = await endpoint.listFiles()
    expect(Object.keys(files).sort()).toEqual(
      [
        'ledger/meta/budgets.json',
        'ledger/meta/categories.json',
        'ledger/meta/members.json',
        'ledger/meta/recurring.json',
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

  it('成员/分类/预算:远端只补缺,双方都有保留本地(v1 规则)', async () => {
    const memberLocal = {
      id: 'm-1',
      username: 'aming',
      displayName: '本地名',
      role: 'admin' as const,
      disabled: false,
      createdAt: T0,
    }
    const memberNew = {
      id: 'm-2',
      username: 'xiaohong',
      displayName: '新成员',
      role: 'member' as const,
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
    remote.meta.members = [{ ...memberLocal, displayName: '远端名' }, memberNew]
    remote.meta.categories = [
      { id: 'c-1', name: '远端分类', sortOrder: 5 },
      { id: 'c-2', name: '新增分类', sortOrder: 2 },
    ]
    remote.meta.budgets = { '2026-09': budgetSep, '2026-10': budgetOctRemote }

    const result = await sync(local, new InMemoryEndpoint(ledgerToFiles(remote)))

    expect(result.conflictsResolved).toBe(0)
    expect(local.meta.members).toEqual([memberLocal, memberNew])
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
    expect(first.pushedFiles).toBe(5) // 1 个月份文件 + 4 个 meta

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
    expect(filesToLedger(await contentsOf(shared))).toEqual(a)

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
