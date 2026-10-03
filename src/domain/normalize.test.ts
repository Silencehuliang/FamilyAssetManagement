import { describe, expect, it } from 'vitest'
import { normalizeLedgerShape } from './normalize'
import type { LedgerData } from './types'

/** v1 形状的缓存:meta 没有 tags/tagGroups,支出只有废弃的自由文本 tagNames */
function v1Ledger(): LedgerData {
  return {
    meta: {
      members: [],
      categories: [{ id: 'c-1', name: '餐饮', sortOrder: 1 }],
      budgets: {},
      recurring: [],
    },
    months: {
      '2026-10': {
        expenses: [
          {
            id: 'e-1',
            amountCents: 1000,
            date: '2026-10-02',
            categoryId: 'c-1',
            tagNames: ['微信'],
            memberId: 'm-1',
            recordedBy: 'm-1',
            createdAt: '2026-10-02T08:00:00.000Z',
            updatedAt: '2026-10-02T08:00:00.000Z',
          },
        ],
      },
    },
  } as unknown as LedgerData
}

describe('normalizeLedgerShape(v1 缓存形状补全,评审修复)', () => {
  it('补齐 meta 集合字段与支出 tagIds;legacy tagNames 原样保留给迁移引擎', () => {
    const ledger = normalizeLedgerShape(v1Ledger())

    expect(ledger.meta.tags).toEqual([])
    expect(ledger.meta.tagGroups).toEqual([])
    expect(ledger.meta.members).toEqual([])
    expect(ledger.meta.budgets).toEqual({})
    expect(ledger.meta.recurring).toEqual([])
    const expense = ledger.months['2026-10']?.expenses[0]
    expect(expense?.tagIds).toEqual([])
    expect(expense?.tagNames).toEqual(['微信'])
  })

  it('meta/months 整体缺失也能补全;月份条目缺 expenses 补空数组', () => {
    const ledger = normalizeLedgerShape({
      months: { '2026-10': null },
    } as unknown as LedgerData)

    expect(ledger.meta).toEqual({
      members: [],
      categories: [],
      tags: [],
      tagGroups: [],
      budgets: {},
      recurring: [],
    })
    expect(ledger.months['2026-10']).toEqual({ expenses: [] })
  })

  it('幂等:对当前形状的账本第二次调用不产生可观察变化', () => {
    const ledger = normalizeLedgerShape(v1Ledger())
    const snapshot = JSON.stringify(ledger)

    normalizeLedgerShape(ledger)

    expect(JSON.stringify(ledger)).toBe(snapshot)
  })
})
