import { describe, expect, it } from 'vitest'
import { aggregateMonth } from './aggregate'
import {
  budgetHistory,
  budgetOutcome,
  budgetProgress,
  clearBudget,
  setCategoryBudget,
  setTotalBudget,
} from './budgets'
import { addExpense } from './expenses'
import { ADMIN, fixtureLedger, LUNCH_CATEGORY, NOW, nextId, XIAOHONG } from './fixtures'
import { DomainError } from './types'

function seedWithSpending() {
  const ledger = fixtureLedger()
  addExpense(
    ledger,
    { amountCents: 12000, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
    { actor: XIAOHONG, now: NOW, newId: nextId() },
  )
  return ledger
}

describe('setTotalBudget', () => {
  it('管理员设置总预算并可覆盖;成员被拒(forbidden)', () => {
    const ledger = fixtureLedger()

    setTotalBudget(ledger, ADMIN, '2026-10', 300000)
    expect(ledger.meta.budgets['2026-10']).toEqual({ totalCents: 300000, categoryCents: {} })

    setTotalBudget(ledger, ADMIN, '2026-10', 250000)
    expect(ledger.meta.budgets['2026-10']?.totalCents).toBe(250000)

    expect(() => setTotalBudget(ledger, XIAOHONG, '2026-10', 100000)).toThrowError(/仅管理员/)
    expect(ledger.meta.budgets['2026-10']?.totalCents).toBe(250000)
  })

  it('校验金额(正整数分)与月份格式', () => {
    const ledger = fixtureLedger()
    expect(() => setTotalBudget(ledger, ADMIN, '2026-10', 0)).toThrowError(DomainError)
    expect(() => setTotalBudget(ledger, ADMIN, '2026-10', -100)).toThrowError(DomainError)
    expect(() => setTotalBudget(ledger, ADMIN, '2026-10', 12.5)).toThrowError(DomainError)
    expect(() => setTotalBudget(ledger, ADMIN, '2026-13', 1000)).toThrowError(/月份/)
    expect(() => setTotalBudget(ledger, ADMIN, '2026-1', 1000)).toThrowError(/月份/)
  })

  it('null 清除总预算;清理后无分类预算则删掉整月条目', () => {
    const ledger = fixtureLedger()
    setTotalBudget(ledger, ADMIN, '2026-10', 300000)
    setCategoryBudget(ledger, ADMIN, '2026-10', LUNCH_CATEGORY, 50000)

    setTotalBudget(ledger, ADMIN, '2026-10', null)
    expect(ledger.meta.budgets['2026-10']).toEqual({ categoryCents: { [LUNCH_CATEGORY]: 50000 } })

    setCategoryBudget(ledger, ADMIN, '2026-10', LUNCH_CATEGORY, null)
    expect(ledger.meta.budgets['2026-10']).toBeUndefined()
  })
})

describe('setCategoryBudget', () => {
  it('仅子分类可设预算;父分类/未知分类被拒', () => {
    const ledger = fixtureLedger()
    setCategoryBudget(ledger, ADMIN, '2026-10', LUNCH_CATEGORY, 60000)
    expect(ledger.meta.budgets['2026-10']?.categoryCents[LUNCH_CATEGORY]).toBe(60000)

    expect(() => setCategoryBudget(ledger, ADMIN, '2026-10', 'cat-dining', 10000)).toThrowError(
      /子分类/,
    )
    expect(() => setCategoryBudget(ledger, ADMIN, '2026-10', 'cat-none', 10000)).toThrowError(
      /分类/,
    )
  })

  it('成员不能设置分类预算', () => {
    const ledger = fixtureLedger()
    expect(() =>
      setCategoryBudget(ledger, XIAOHONG, '2026-10', LUNCH_CATEGORY, 60000),
    ).toThrowError(/仅管理员/)
    expect(ledger.meta.budgets['2026-10']).toBeUndefined()
  })
})

describe('clearBudget', () => {
  it('清除整月预算,仅管理员', () => {
    const ledger = fixtureLedger()
    setTotalBudget(ledger, ADMIN, '2026-10', 300000)
    setCategoryBudget(ledger, ADMIN, '2026-10', LUNCH_CATEGORY, 50000)

    clearBudget(ledger, ADMIN, '2026-10')
    expect(ledger.meta.budgets['2026-10']).toBeUndefined()

    expect(() => clearBudget(ledger, XIAOHONG, '2026-10')).toThrowError(/仅管理员/)
  })
})

describe('budgetProgress', () => {
  it('总预算:余量与超支判定', () => {
    const ledger = seedWithSpending()
    setTotalBudget(ledger, ADMIN, '2026-10', 10000)
    setTotalBudget(ledger, ADMIN, '2026-09', 20000)

    const over = budgetProgress(aggregateMonth(ledger, '2026-10'), ledger.meta.budgets['2026-10'])
    expect(over).toMatchObject({
      hasTotalBudget: true,
      totalCents: 10000,
      spentCents: 12000,
      remainingCents: -2000,
      overspent: true,
    })

    const under = budgetProgress(aggregateMonth(ledger, '2026-09'), ledger.meta.budgets['2026-09'])
    expect(under).toMatchObject({ spentCents: 0, remainingCents: 20000, overspent: false })
  })

  it('未设预算:hasTotalBudget=false,不判超支;分类预算缺失按 0 支出', () => {
    const ledger = seedWithSpending()
    setCategoryBudget(ledger, ADMIN, '2026-10', 'cat-dining-3', 5000)

    const progress = budgetProgress(
      aggregateMonth(ledger, '2026-10'),
      ledger.meta.budgets['2026-10'],
    )
    expect(progress).toMatchObject({
      hasTotalBudget: false,
      totalCents: 0,
      spentCents: 12000,
      overspent: false,
    })
    expect(progress.byCategory).toEqual([
      {
        categoryId: 'cat-dining-3',
        budgetCents: 5000,
        spentCents: 0,
        remainingCents: 5000,
        overspent: false,
      },
    ])

    const absent = budgetProgress(aggregateMonth(ledger, '2026-10'), undefined)
    expect(absent.hasTotalBudget).toBe(false)
    expect(absent.byCategory).toEqual([])
  })

  it('分类预算按支出聚合判定超支,金额降序', () => {
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      { amountCents: 8000, date: '2026-10-01', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: NOW, newId: nextId() },
    )
    addExpense(
      ledger,
      { amountCents: 3000, date: '2026-10-02', categoryId: 'cat-dining-3' },
      { actor: XIAOHONG, now: NOW, newId: nextId() },
    )
    setCategoryBudget(ledger, ADMIN, '2026-10', LUNCH_CATEGORY, 5000)
    setCategoryBudget(ledger, ADMIN, '2026-10', 'cat-dining-3', 5000)

    const progress = budgetProgress(
      aggregateMonth(ledger, '2026-10'),
      ledger.meta.budgets['2026-10'],
    )
    expect(progress.byCategory).toEqual([
      {
        categoryId: LUNCH_CATEGORY,
        budgetCents: 5000,
        spentCents: 8000,
        remainingCents: -3000,
        overspent: true,
      },
      {
        categoryId: 'cat-dining-3',
        budgetCents: 5000,
        spentCents: 3000,
        remainingCents: 2000,
        overspent: false,
      },
    ])
  })
})

describe('budgetOutcome / budgetHistory', () => {
  it('达成与超支;未设总预算的月份不计入历史', () => {
    const ledger = fixtureLedger()
    addExpense(
      ledger,
      { amountCents: 8000, date: '2026-10-01', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: NOW, newId: nextId() },
    )
    addExpense(
      ledger,
      { amountCents: 9000, date: '2026-09-15', categoryId: LUNCH_CATEGORY },
      { actor: XIAOHONG, now: NOW, newId: nextId() },
    )
    setTotalBudget(ledger, ADMIN, '2026-10', 10000)
    setTotalBudget(ledger, ADMIN, '2026-09', 5000)
    setCategoryBudget(ledger, ADMIN, '2026-08', LUNCH_CATEGORY, 1000) // 无总预算

    expect(budgetOutcome(ledger, '2026-10')).toEqual({
      month: '2026-10',
      totalCents: 10000,
      spentCents: 8000,
      achieved: true,
    })
    expect(budgetOutcome(ledger, '2026-08')).toBeNull()

    expect(budgetHistory(ledger)).toEqual([
      { month: '2026-10', totalCents: 10000, spentCents: 8000, achieved: true },
      { month: '2026-09', totalCents: 5000, spentCents: 9000, achieved: false },
    ])
  })
})
