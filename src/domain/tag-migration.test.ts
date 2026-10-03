import { describe, expect, it } from 'vitest'
import { InMemoryEndpoint, sync } from '../sync'
import { addExpense } from './expenses'
import { fixtureLedger, LUNCH_CATEGORY, NOW, XIAOHONG } from './fixtures'
import { migrateLegacyTagNames } from './tag-migration'
import { tagIdFromName } from './tags'
import type { Expense, LedgerData, Tag } from './types'

function addLegacy(
  ledger: LedgerData,
  input: { id: string; date: string; tagNames: string[] },
): void {
  addExpense(
    ledger,
    {
      amountCents: 1000,
      date: input.date,
      categoryId: LUNCH_CATEGORY,
      tagNames: input.tagNames,
    },
    { actor: XIAOHONG, now: NOW, newId: input.id },
  )
}

/** 含两笔旧标签支出的账本(跨月) */
function legacyLedger(): LedgerData {
  const ledger = fixtureLedger()
  addLegacy(ledger, { id: 'e-1', date: '2026-10-02', tagNames: ['微信', '现金'] })
  addLegacy(ledger, { id: 'e-2', date: '2026-09-28', tagNames: ['微信'] })
  return ledger
}

function expenseOf(ledger: LedgerData, month: string, id: string): Expense {
  const expense = ledger.months[month]?.expenses.find((e) => e.id === id)
  if (!expense) throw new Error(`fixture: ${month}/${id} 缺失`)
  return expense
}

function tagNamesOf(ledger: LedgerData): string[] {
  return ledger.meta.tags.map((t) => t.name).sort()
}

describe('migrateLegacyTagNames', () => {
  it('扫描全部支出:派生实体、改写 tagIds、移除 tagNames', async () => {
    const ledger = legacyLedger()

    const result = await migrateLegacyTagNames(ledger, '2026-11-01T00:00:00.000Z')

    expect(result).toEqual({ migratedExpenses: 2, addedTags: 2 })
    expect(tagNamesOf(ledger)).toEqual(['微信', '现金'])
    expect(ledger.meta.tags.map((t) => t.updatedAt)).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ])
    const wx = await tagIdFromName('微信')
    const cash = await tagIdFromName('现金')
    const e1 = expenseOf(ledger, '2026-10', 'e-1')
    const e2 = expenseOf(ledger, '2026-09', 'e-2')
    expect(e1.tagIds).toEqual([wx, cash].sort())
    expect(e2.tagIds).toEqual([wx])
    expect('tagNames' in e1).toBe(false)
    expect('tagNames' in e2).toBe(false)
    // 迁移是表示转换:updatedAt 不变
    expect(e1.updatedAt).toBe(NOW)
    expect(e2.updatedAt).toBe(NOW)
  })

  it('与已有标签合并:同 id 保留既有实体(名字/时间戳),缺失的补建', async () => {
    const ledger = legacyLedger()
    const wx = await tagIdFromName('微信')
    const existing: Tag = { id: wx, name: '微信(旧名)', updatedAt: '2026-01-01T00:00:00.000Z' }
    ledger.meta.tags = [existing]

    const result = await migrateLegacyTagNames(ledger, '2026-11-01T00:00:00.000Z')

    expect(result.addedTags).toBe(1)
    expect(ledger.meta.tags).toContainEqual(existing)
    expect(ledger.meta.tags.find((t) => t.id === wx)).toEqual(existing)
    expect(tagNamesOf(ledger)).toEqual(['微信(旧名)', '现金'])
  })

  it('幂等:第二遍报告 0、账本逐字节不变', async () => {
    const ledger = legacyLedger()
    await migrateLegacyTagNames(ledger, '2026-11-01T00:00:00.000Z')
    const snapshot = JSON.stringify(ledger)

    const second = await migrateLegacyTagNames(ledger, '2026-12-01T00:00:00.000Z')

    expect(second).toEqual({ migratedExpenses: 0, addedTags: 0 })
    expect(JSON.stringify(ledger)).toBe(snapshot)
  })

  it('确定性:同一批旧数据独立迁移出同一批 id 与 tagIds(时间戳可不同)', async () => {
    const a = legacyLedger()
    const b = structuredClone(a)
    await migrateLegacyTagNames(a, '2026-11-01T00:00:00.000Z')
    await migrateLegacyTagNames(b, '2026-12-01T00:00:00.000Z')

    expect(a.months).toEqual(b.months)
    expect(a.meta.tags.map((t) => ({ id: t.id, name: t.name }))).toEqual(
      b.meta.tags.map((t) => ({ id: t.id, name: t.name })),
    )
  })

  it('重复/空白名字去重,兼容缺少 tagIds 字段的旧记录', async () => {
    const ledger = fixtureLedger()
    addLegacy(ledger, { id: 'e-1', date: '2026-10-02', tagNames: ['微信', '微信', '  ', ''] })
    const legacy = expenseOf(ledger, '2026-10', 'e-1')
    delete (legacy as Partial<Expense>).tagIds // 旧记录可能完全没有 tagIds 字段

    const result = await migrateLegacyTagNames(ledger, NOW)

    expect(result).toEqual({ migratedExpenses: 1, addedTags: 1 })
    expect(tagNamesOf(ledger)).toEqual(['微信'])
    expect(legacy.tagIds).toEqual([await tagIdFromName('微信')])
  })

  it('两个设备独立迁移同一批旧数据后经同步引擎合并收敛一致', async () => {
    const deviceA = legacyLedger()
    const deviceB = structuredClone(deviceA)
    await migrateLegacyTagNames(deviceA, '2026-11-01T00:00:00.000Z')
    await migrateLegacyTagNames(deviceB, '2026-12-01T00:00:00.000Z')

    const shared = new InMemoryEndpoint()
    await sync(deviceA, shared)
    await sync(deviceB, shared)
    await sync(deviceA, shared)
    await sync(deviceB, shared)

    expect(deviceA).toEqual(deviceB)
    const files = await shared.listFiles()
    for (const [path, file] of Object.entries(files)) {
      if (path.startsWith('ledger/months/')) expect(file.content).not.toContain('tagNames')
    }
    expect(Object.keys(files)).toContain('ledger/meta/tags.json')
  })
})
