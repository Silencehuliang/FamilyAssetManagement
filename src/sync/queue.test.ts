import { describe, expect, it } from 'vitest'
import type { Expense, LedgerData, Member, MutationContext } from '../domain'
import { addExpense, deleteExpense } from '../domain'
import { filesToLedger, ledgerToFiles, monthFilePath } from './files'
import { InMemoryEndpoint } from './in-memory'
import { PendingQueue, replay } from './queue'

const T0 = '2026-10-02T08:00:00.000Z'

const MEMBER: Member = {
  id: 'm-1',
  username: 'aming',
  displayName: '阿明',
  role: 'admin',
  disabled: false,
  createdAt: T0,
}

function baseExpense(id: string, date = '2026-10-02'): Expense {
  return {
    id,
    amountCents: 1000,
    date,
    categoryId: 'c-2',
    tagNames: [],
    memberId: 'm-1',
    recordedBy: 'm-1',
    createdAt: T0,
    updatedAt: T0,
  }
}

/** 已与端点同步过的基线账本:两个成员、两级分类、10 月预算、一笔支出 */
function baseLedger(): LedgerData {
  return {
    meta: {
      members: [
        MEMBER,
        {
          id: 'm-2',
          username: 'xiaohong',
          displayName: '小红',
          role: 'member',
          disabled: false,
          createdAt: T0,
        },
      ],
      categories: [
        { id: 'c-1', name: '餐饮', sortOrder: 1 },
        { id: 'c-2', name: '午餐', parentId: 'c-1', sortOrder: 1 },
      ],
      budgets: { '2026-10': { totalCents: 100000, categoryCents: {} } },
      recurring: [],
    },
    months: { '2026-10': { expenses: [baseExpense('e-1')] } },
  }
}

function ctx(now: string, newId = 'unused'): MutationContext {
  return { actor: MEMBER, now, newId }
}

async function contentsOf(endpoint: InMemoryEndpoint): Promise<Record<string, string>> {
  const files = await endpoint.listFiles()
  const contents: Record<string, string> = {}
  for (const [path, file] of Object.entries(files)) contents[path] = file.content
  return contents
}

function monthContentOf(ledger: LedgerData, month: string): string {
  const content = ledgerToFiles(ledger)[monthFilePath(month)]
  if (content === undefined) throw new Error(`测试辅助:${month} 无月份文件`)
  return content
}

describe('replay', () => {
  it('队列为空时等价于 sync:离线新增经合并推上端点', async () => {
    const baseline = baseLedger()
    const shared = new InMemoryEndpoint(ledgerToFiles(baseline))
    const local = structuredClone(baseline)
    addExpense(
      local,
      { amountCents: 700, date: '2026-10-05', categoryId: 'c-2' },
      ctx('2026-10-02T09:00:00.000Z', 'e-9'),
    )

    const result = await replay(new PendingQueue(), local, shared)

    expect(result.pushedFiles).toBe(1)
    expect(filesToLedger(await contentsOf(shared))).toEqual(local)
  })

  it('离线新增与删除混合:回放后三方收敛,队列清空', async () => {
    const baseline = baseLedger()
    baseline.months['2026-10']?.expenses.push(baseExpense('e-2', '2026-10-03'))
    const shared = new InMemoryEndpoint(ledgerToFiles(baseline))
    const local = structuredClone(baseline)

    // 离线:新增 e-3(不登记,由 LWW 合并传播),删除 e-1(登记)
    addExpense(
      local,
      { amountCents: 1200, date: '2026-10-02', categoryId: 'c-2' },
      ctx('2026-10-02T09:00:00.000Z', 'e-3'),
    )
    deleteExpense(local, 'e-1', ctx('2026-10-02T09:30:00.000Z'))
    const queue = new PendingQueue()
    queue.record({
      type: 'delete-expense',
      id: 'e-1',
      month: '2026-10',
      deletedAt: '2026-10-02T09:30:00.000Z',
    })
    expect(queue.pending.map((op) => op.type)).toEqual(['delete-expense'])

    await replay(queue, local, shared)

    expect(queue.size).toBe(0)
    const ids = local.months['2026-10']?.expenses.map((e) => e.id)
    expect(ids).toEqual(['e-3', 'e-2'])
    expect(filesToLedger(await contentsOf(shared))).toEqual(local)
  })

  it('月份的最后一条支出被删:端点月份文件被删除', async () => {
    const baseline = baseLedger()
    const shared = new InMemoryEndpoint(ledgerToFiles(baseline))
    const local = structuredClone(baseline)
    deleteExpense(local, 'e-1', ctx('2026-10-02T09:00:00.000Z'))
    const queue = new PendingQueue()
    queue.record({
      type: 'delete-expense',
      id: 'e-1',
      month: '2026-10',
      deletedAt: '2026-10-02T09:00:00.000Z',
    })

    const result = await replay(queue, local, shared)

    expect(local.months['2026-10']).toBeUndefined()
    expect(result.pushedFiles).toBe(1)
    const files = await shared.listFiles()
    expect(files[monthFilePath('2026-10')]).toBeUndefined()
    expect(queue.size).toBe(0)
  })

  it('晚于删除的远端编辑按 LWW 胜出,删除被放弃', async () => {
    const baseline = baseLedger()
    const shared = new InMemoryEndpoint(ledgerToFiles(baseline))
    // 另一台设备在本地删除之后编辑了 e-1(updatedAt 晚于 deletedAt)
    const editedLedger = baseLedger()
    const edited = baseExpense('e-1')
    edited.amountCents = 5000
    edited.updatedAt = '2026-10-02T10:00:00.000Z'
    editedLedger.months['2026-10'] = { expenses: [edited] }
    shared.assignFile(monthFilePath('2026-10'), monthContentOf(editedLedger, '2026-10'))

    const local = structuredClone(baseline)
    deleteExpense(local, 'e-1', ctx('2026-10-02T09:00:00.000Z'))
    const queue = new PendingQueue()
    queue.record({
      type: 'delete-expense',
      id: 'e-1',
      month: '2026-10',
      deletedAt: '2026-10-02T09:00:00.000Z',
    })

    await replay(queue, local, shared)

    expect(local.months['2026-10']?.expenses.find((e) => e.id === 'e-1')?.amountCents).toBe(5000)
    expect(filesToLedger(await contentsOf(shared))).toEqual(local)
    expect(queue.size).toBe(0)
  })

  it('成员/分类删除与清空预算按登记顺序回放(合并会先复活,再补删)', async () => {
    const baseline = baseLedger()
    const shared = new InMemoryEndpoint(ledgerToFiles(baseline))
    const local = structuredClone(baseline)

    // 离线删除(领域层应用之后逐条登记)
    local.meta.members = local.meta.members.filter((m) => m.id !== 'm-2')
    local.meta.categories = local.meta.categories.filter((c) => c.id !== 'c-2')
    delete local.meta.budgets['2026-10']
    const queue = new PendingQueue()
    queue.record({ type: 'delete-member', id: 'm-2' })
    queue.record({ type: 'delete-category', id: 'c-2' })
    queue.record({ type: 'clear-budget', month: '2026-10' })
    expect(queue.pending.map((op) => op.type)).toEqual([
      'delete-member',
      'delete-category',
      'clear-budget',
    ])

    const result = await replay(queue, local, shared)

    // 远端旧副本会在合并中复活,靠补删写回:3 个 meta 文件各推送一次
    expect(result.pushedFiles).toBe(3)
    const remoteLedger = filesToLedger(await contentsOf(shared))
    expect(remoteLedger).toEqual(local)
    expect(remoteLedger.meta.members.map((m) => m.id)).toEqual(['m-1'])
    expect(remoteLedger.meta.categories.map((c) => c.id)).toEqual(['c-1'])
    expect(remoteLedger.meta.budgets).toEqual({})
    expect(queue.size).toBe(0)
  })

  it('周期支出删除经回放传播', async () => {
    const baseline = baseLedger()
    baseline.meta.recurring = [
      {
        id: 'r-1',
        amountCents: 3000,
        categoryId: 'c-2',
        tagNames: [],
        memberId: 'm-1',
        frequency: 'monthly',
        startDate: '2026-10-01',
        enabled: true,
        createdAt: T0,
        updatedAt: T0,
      },
    ]
    const shared = new InMemoryEndpoint(ledgerToFiles(baseline))
    const local = structuredClone(baseline)
    local.meta.recurring = []
    const queue = new PendingQueue()
    queue.record({ type: 'delete-recurring', id: 'r-1', deletedAt: '2026-10-02T09:00:00.000Z' })

    await replay(queue, local, shared)

    expect(filesToLedger(await contentsOf(shared))).toEqual(local)
    expect(queue.size).toBe(0)
  })
})
