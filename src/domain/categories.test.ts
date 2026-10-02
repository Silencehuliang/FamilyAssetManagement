import { describe, expect, it } from 'vitest'
import {
  addCategory,
  childrenOf,
  deleteCategory,
  parentCategories,
  updateCategory,
} from './categories'
import { DEFAULT_CATEGORIES } from './defaults'
import { addExpense } from './expenses'
import {
  ADMIN,
  DINNER_CATEGORY,
  expenseAt,
  fixtureLedger,
  LUNCH_CATEGORY,
  NOW,
  nextId,
  XIAOHONG,
} from './fixtures'
import { DomainError } from './types'

const adminCtx = () => ({ actor: ADMIN, now: NOW, newId: nextId() })

describe('DEFAULT_CATEGORIES', () => {
  it('是合法的两级结构:父分类无 parentId,子分类指向存在的父分类', () => {
    const ids = new Set(DEFAULT_CATEGORIES.map((c) => c.id))
    for (const c of DEFAULT_CATEGORIES) {
      if (c.parentId)
        expect(ids.has(c.parentId), `${c.id} 的父分类 ${c.parentId} 应存在`).toBe(true)
    }
    expect(DEFAULT_CATEGORIES.filter((c) => !c.parentId).length).toBeGreaterThanOrEqual(8)
  })
})

describe('分类管理(仅管理员)', () => {
  it('成员无权增删改,管理员可以', () => {
    const ledger = fixtureLedger()
    expect(() => addCategory(ledger, XIAOHONG, { id: 'cat-x', name: '新分类' })).toThrowError(
      DomainError,
    )
    addCategory(ledger, ADMIN, { id: 'cat-hobby', name: '爱好' })
    expect(ledger.meta.categories.some((c) => c.name === '爱好')).toBe(true)
    updateCategory(ledger, ADMIN, 'cat-hobby', { name: '兴趣爱好' })
    expect(ledger.meta.categories.some((c) => c.name === '兴趣爱好')).toBe(true)
    deleteCategory(ledger, ADMIN, 'cat-hobby')
    expect(ledger.meta.categories.some((c) => c.id === 'cat-hobby')).toBe(false)
  })

  it('同级不允许重名', () => {
    const ledger = fixtureLedger()
    expect(() => addCategory(ledger, ADMIN, { id: 'cat-dup', name: '餐饮' })).toThrowError(/同名/)
    expect(() =>
      addCategory(ledger, ADMIN, { id: 'cat-dup-child', name: '午餐', parentId: 'cat-shopping' }),
    ).not.toThrow()
  })

  it('删除有支出的子分类:不给迁移目标报错;给了就迁移全部支出', () => {
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      { amountCents: 100, date: '2026-10-01', categoryId: LUNCH_CATEGORY },
      adminCtx(),
    )
    addExpense(
      ledger,
      { amountCents: 200, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      adminCtx(),
    )

    expect(() => deleteCategory(ledger, ADMIN, LUNCH_CATEGORY)).toThrowError(/迁移/)
    expect(() => deleteCategory(ledger, ADMIN, LUNCH_CATEGORY, 'cat-transport-1')).toThrowError(
      /同一个父分类/,
    )

    deleteCategory(ledger, ADMIN, LUNCH_CATEGORY, DINNER_CATEGORY)
    expect(expenseAt(ledger, '2026-10', 0).categoryId).toBe(DINNER_CATEGORY)
    expect(expenseAt(ledger, '2026-10', 1).categoryId).toBe(DINNER_CATEGORY)
    expect(ledger.meta.categories.some((c) => c.id === LUNCH_CATEGORY)).toBe(false)
  })

  it('删除仍有子分类的父分类被拒绝;删空子分类后可以', () => {
    const ledger = fixtureLedger()
    expect(() => deleteCategory(ledger, ADMIN, 'cat-dining')).toThrowError(/子分类/)
    for (const child of childrenOf(ledger, 'cat-dining').map((c) => c.id)) {
      deleteCategory(ledger, ADMIN, child)
    }
    deleteCategory(ledger, ADMIN, 'cat-dining')
    expect(ledger.meta.categories.some((c) => c.id === 'cat-dining')).toBe(false)
  })
})

describe('分类查询辅助', () => {
  it('parentCategories / childrenOf 按 sortOrder 排序', () => {
    const ledger = fixtureLedger()
    const parents = parentCategories(ledger)
    expect(parents[0]?.name).toBe('餐饮')
    const diningChildren = childrenOf(ledger, 'cat-dining')
    expect(diningChildren.map((c) => c.name)).toEqual(['早餐', '午餐', '晚餐', '外卖', '零食饮料'])
  })
})
