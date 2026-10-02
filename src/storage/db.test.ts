import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { addExpense, createEmptyLedger, DEFAULT_CATEGORIES, deleteExpense } from '../domain'
import { fixtureLedger, LUNCH_CATEGORY, NOW, XIAOHONG } from '../domain/fixtures'
import { DexieLocalStore, LedgerDatabase } from './db'
import { MemoryLocalStore } from './memory'
import { PersistentQueue } from './persistent-queue'

const databases: LedgerDatabase[] = []

function makeStore(name: string): DexieLocalStore {
  const db = new LedgerDatabase(name)
  databases.push(db)
  return new DexieLocalStore(db)
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.delete()))
})

describe('DexieLocalStore 本地持久化', () => {
  it('账本快照往返(含月份支出、分类、成员)', async () => {
    const store = makeStore('test-ledger-roundtrip')
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      {
        amountCents: 2550,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信'],
        note: '食堂',
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )

    await store.saveLedger(ledger)
    const loaded = await store.loadLedger()

    expect(loaded).toEqual(ledger)
    expect(loaded?.months['2026-10']?.expenses[0]?.amountCents).toBe(2550)
  })

  it('空库返回 null;覆盖保存后只留最新快照', async () => {
    const store = makeStore('test-ledger-overwrite')
    await expect(store.loadLedger()).resolves.toBeNull()

    const first = createEmptyLedger()
    first.meta.categories = [...DEFAULT_CATEGORIES]
    await store.saveLedger(first)

    const second = createEmptyLedger()
    await store.saveLedger(second)

    await expect(store.loadLedger()).resolves.toEqual(second)
    const rows = await databases[0]?.ledger.count()
    expect(rows).toBe(1)
  })

  it('成员视图往返', async () => {
    const store = makeStore('test-members')
    expect(await store.loadMembers()).toBeNull()

    await store.saveMembers([XIAOHONG])
    await expect(store.loadMembers()).resolves.toEqual([XIAOHONG])
  })

  it('队列操作往返且保序', async () => {
    const store = makeStore('test-queue')
    expect(await store.loadQueueOps()).toEqual([])

    await store.saveQueueOps([
      { type: 'delete-expense', id: 'e-1', month: '2026-10', deletedAt: NOW },
      { type: 'delete-category', id: 'cat-x' },
    ])

    await expect(store.loadQueueOps()).resolves.toEqual([
      { type: 'delete-expense', id: 'e-1', month: '2026-10', deletedAt: NOW },
      { type: 'delete-category', id: 'cat-x' },
    ])

    await store.saveQueueOps([])
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })
})

describe('PersistentQueue 写穿队列', () => {
  it('登记与清空写穿到存储,hydrate 恢复未回放操作', async () => {
    const store = new MemoryLocalStore()
    const queue = await PersistentQueue.hydrate(store)
    expect(queue.size).toBe(0)

    queue.record({ type: 'delete-expense', id: 'e-9', month: '2026-09', deletedAt: NOW })
    await Promise.resolve()

    const restored = await PersistentQueue.hydrate(store)
    expect(restored.pending).toEqual([
      { type: 'delete-expense', id: 'e-9', month: '2026-09', deletedAt: NOW },
    ])

    restored.clear()
    await Promise.resolve()
    const afterClear = await PersistentQueue.hydrate(store)
    expect(afterClear.size).toBe(0)
  })

  it('离线删除经持久队列回放后,删除操作不因重启丢失', async () => {
    const store = new MemoryLocalStore()
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )
    await store.saveLedger(ledger)

    const queue = await PersistentQueue.hydrate(store)
    deleteExpense(ledger, 'e-1', { actor: XIAOHONG, now: NOW, newId: 'unused' })
    queue.record({ type: 'delete-expense', id: 'e-1', month: '2026-10', deletedAt: NOW })
    await store.saveLedger(ledger)
    await Promise.resolve()

    // 模拟应用重启:从持久化恢复账本与队列
    const reloadedLedger = await store.loadLedger()
    const reloadedQueue = await PersistentQueue.hydrate(store)

    expect(reloadedLedger?.months['2026-10']).toBeUndefined()
    expect(reloadedQueue.pending).toHaveLength(1)
  })
})
