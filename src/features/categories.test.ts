import { describe, expect, it } from 'vitest'
import { addCategory, addExpense, deleteCategory } from '../domain'
import { ADMIN, fixtureLedger, LUNCH_CATEGORY, XIAOHONG } from '../domain/fixtures'
import {
  canManageCategories,
  categoryInUse,
  categoryTree,
  countExpensesInCategory,
  migrationTargets,
  nextSortOrder,
} from './categories'

describe('categoryTree(两级树与排序)', () => {
  it('父分类与子分类按 sortOrder 排列,尊重自定义顺序', () => {
    const ledger = fixtureLedger()
    ledger.meta.categories = [
      { id: 'b', name: '乙', sortOrder: 2 },
      { id: 'a', name: '甲', sortOrder: 1 },
      { id: 'b-2', name: '乙二', parentId: 'b', sortOrder: 5 },
      { id: 'b-1', name: '乙一', parentId: 'b', sortOrder: 1 },
      { id: 'a-1', name: '甲一', parentId: 'a', sortOrder: 0 },
    ]

    const tree = categoryTree(ledger)

    expect(tree.map((node) => node.parent.id)).toEqual(['a', 'b'])
    expect(tree[1]?.children.map((c) => c.id)).toEqual(['b-1', 'b-2'])
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['a-1'])
  })

  it('新增子分类取同级最大位次 + 1;父分类同理', () => {
    const ledger = fixtureLedger()
    expect(nextSortOrder(ledger, 'cat-dining')).toBe(5) // 预设 5 个子分类
    const empty = fixtureLedger()
    empty.meta.categories = []
    expect(nextSortOrder(empty)).toBe(0)

    addCategory(empty, ADMIN, { id: 'x', name: '新父', sortOrder: 0 })
    expect(nextSortOrder(empty)).toBe(1)
    addCategory(empty, ADMIN, { id: 'x-1', name: '新子', parentId: 'x', sortOrder: 0 })
    expect(nextSortOrder(empty, 'x')).toBe(1)
  })
})

describe('分类使用量统计与迁移候选', () => {
  it('countExpensesInCategory/categoryInUse 跨月统计', () => {
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: '2026-10-02T08:00:00.000Z', newId: 'e-1' },
    )
    addExpense(
      ledger,
      { amountCents: 200, date: '2026-09-30', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: '2026-09-30T08:00:00.000Z', newId: 'e-2' },
    )

    expect(countExpensesInCategory(ledger, LUNCH_CATEGORY)).toBe(2)
    expect(categoryInUse(ledger, LUNCH_CATEGORY)).toBe(true)
    expect(categoryInUse(ledger, 'cat-dining-3')).toBe(false)
  })

  it('migrationTargets 只含同父下的其他子分类', () => {
    const ledger = fixtureLedger()
    const targets = migrationTargets(ledger, LUNCH_CATEGORY)
    expect(targets.map((c) => c.name)).toEqual(['早餐', '晚餐', '外卖', '零食饮料'])
    expect(migrationTargets(ledger, 'cat-dining')).toEqual([])

    // 迁移目标随分类删除而减少
    deleteCategory(ledger, ADMIN, 'cat-dining-3')
    expect(migrationTargets(ledger, LUNCH_CATEGORY).map((c) => c.name)).toEqual([
      '早餐',
      '外卖',
      '零食饮料',
    ])
  })
})

describe('canManageCategories(管理员门禁)', () => {
  it('仅管理员为 true;成员与未登录为 false', () => {
    expect(canManageCategories(ADMIN)).toBe(true)
    expect(canManageCategories(XIAOHONG)).toBe(false)
    expect(canManageCategories(null)).toBe(false)
  })
})
