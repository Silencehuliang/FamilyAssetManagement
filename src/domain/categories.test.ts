import { describe, expect, it } from 'vitest'
import {
  addCategory,
  childrenOf,
  deleteCategory,
  parentCategories,
  reorderCategories,
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

describe('分类颜色(V8,仅管理员)', () => {
  it('新增/修改可保存 7 色之一;成员被拒', () => {
    const ledger = fixtureLedger()

    addCategory(ledger, ADMIN, { id: 'cat-coffee', name: '咖啡', color: 'purple' })
    expect(ledger.meta.categories.find((c) => c.id === 'cat-coffee')?.color).toBe('purple')

    updateCategory(ledger, ADMIN, 'cat-coffee', { color: 'green' })
    expect(ledger.meta.categories.find((c) => c.id === 'cat-coffee')?.color).toBe('green')

    expect(() =>
      addCategory(ledger, XIAOHONG, { id: 'cat-x', name: '爱好', color: 'red' }),
    ).toThrowError(DomainError)
  })

  it('调色板外的颜色被拒(invalid_color),不写入账本', () => {
    const ledger = fixtureLedger()
    expect(() =>
      addCategory(ledger, ADMIN, {
        id: 'cat-bad',
        name: '坏色',
        color: 'pink' as unknown as 'red',
      }),
    ).toThrowError(/不支持/)
    expect(() =>
      updateCategory(ledger, ADMIN, 'cat-dining', { color: 'pink' as unknown as 'red' }),
    ).toThrowError(/不支持/)
    expect(ledger.meta.categories.find((c) => c.id === 'cat-dining')?.color).toBeUndefined()
  })
})

describe('reorderCategories(拖拽排序,仅管理员)', () => {
  it('父分类按给定顺序重写 sortOrder,子分类不受影响', () => {
    const ledger = fixtureLedger()
    const ids = parentCategories(ledger).map((c) => c.id)
    const reversed = [...ids].reverse()

    reorderCategories(ledger, ADMIN, null, reversed)

    expect(parentCategories(ledger).map((c) => c.id)).toEqual(reversed)
    expect(parentCategories(ledger).map((c) => c.sortOrder)).toEqual(
      reversed.map((_, index) => index),
    )
    // 子分类位次原样保留
    expect(childrenOf(ledger, 'cat-dining').map((c) => c.name)).toEqual([
      '早餐',
      '午餐',
      '晚餐',
      '外卖',
      '零食饮料',
    ])
  })

  it('子分类排序限定同一父分类,其他父分类的子分类顺序不变', () => {
    const ledger = fixtureLedger()
    const diningIds = childrenOf(ledger, 'cat-dining').map((c) => c.id)
    const shuffled = [
      diningIds[2],
      diningIds[0],
      diningIds[4],
      diningIds[1],
      diningIds[3],
    ] as string[]

    reorderCategories(ledger, ADMIN, 'cat-dining', shuffled)

    expect(childrenOf(ledger, 'cat-dining').map((c) => c.id)).toEqual(shuffled)
    expect(childrenOf(ledger, 'cat-transport').map((c) => c.name)).toEqual([
      '公共交通',
      '打车',
      '加油',
      '停车过路',
    ])
  })

  it('列表不完整/含重复/跨父时拒绝(category_reorder_mismatch),排序不变', () => {
    const ledger = fixtureLedger()
    const before = parentCategories(ledger).map((c) => c.id)

    expect(() => reorderCategories(ledger, ADMIN, null, before.slice(0, 3))).toThrowError(/排序/)
    expect(() =>
      reorderCategories(ledger, ADMIN, null, [...before, before[0] as string]),
    ).toThrowError(/排序/)
    // 子分类列表里混入父分类 id 同样被拒
    expect(() =>
      reorderCategories(ledger, ADMIN, 'cat-dining', ['cat-transport', 'cat-dining-1']),
    ).toThrowError(/排序/)
    expect(parentCategories(ledger).map((c) => c.id)).toEqual(before)
  })

  it('普通成员无权排序', () => {
    const ledger = fixtureLedger()
    const ids = parentCategories(ledger).map((c) => c.id)
    expect(() => reorderCategories(ledger, XIAOHONG, null, ids)).toThrowError(/仅管理员/)
  })
})
