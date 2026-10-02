import { describe, expect, it } from 'vitest'
import { addExpense, canEditExpense, deleteExpense, updateExpense } from './expenses'
import {
  ADMIN,
  expenseAt,
  fixtureLedger,
  LAOSAN,
  LUNCH_CATEGORY,
  NOW,
  nextId,
  XIAOHONG,
} from './fixtures'
import { DomainError } from './types'

function ctx(actor = XIAOHONG, now = NOW) {
  return { actor, now, newId: nextId() }
}

describe('addExpense', () => {
  it('默认记在记录者名下,可代其他成员记账', () => {
    const ledger = fixtureLedger()
    addExpense(ledger, { amountCents: 2500, date: '2026-10-02', categoryId: LUNCH_CATEGORY }, ctx())
    addExpense(
      ledger,
      { amountCents: 1000, date: '2026-10-02', categoryId: LUNCH_CATEGORY, memberId: ADMIN.id },
      ctx(),
    )
    expect(ledger.months['2026-10']?.expenses).toHaveLength(2)
    expect(expenseAt(ledger, '2026-10', 0).memberId).toBe(XIAOHONG.id)
    expect(expenseAt(ledger, '2026-10', 1).memberId).toBe(ADMIN.id)
  })

  it('落进对应月份文件', () => {
    const ledger = fixtureLedger()
    addExpense(ledger, { amountCents: 100, date: '2026-09-30', categoryId: LUNCH_CATEGORY }, ctx())
    addExpense(ledger, { amountCents: 200, date: '2026-10-01', categoryId: LUNCH_CATEGORY }, ctx())
    expect(Object.keys(ledger.months).sort()).toEqual(['2026-09', '2026-10'])
  })

  it('拒绝:金额非正/非整数、坏日期、非子分类、未知成员、停用成员、停用记录者', () => {
    const ledger = fixtureLedger()
    expect(() =>
      addExpense(ledger, { amountCents: 0, date: '2026-10-02', categoryId: LUNCH_CATEGORY }, ctx()),
    ).toThrowError(DomainError)
    expect(() =>
      addExpense(
        ledger,
        { amountCents: 10.5, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
        ctx(),
      ),
    ).toThrowError(DomainError)
    expect(() =>
      addExpense(
        ledger,
        { amountCents: 100, date: '2026-10-02 ', categoryId: LUNCH_CATEGORY },
        ctx(),
      ),
    ).toThrowError(DomainError)
    expect(() =>
      addExpense(
        ledger,
        { amountCents: 100, date: '2026-02-30', categoryId: LUNCH_CATEGORY },
        ctx(),
      ),
    ).toThrowError(DomainError)
    expect(() =>
      addExpense(ledger, { amountCents: 100, date: '2026-10-02', categoryId: 'cat-dining' }, ctx()),
    ).toThrowError(/子分类/)
    expect(() =>
      addExpense(
        ledger,
        { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY, memberId: 'm-none' },
        ctx(),
      ),
    ).toThrowError(/成员/)
    expect(() =>
      addExpense(
        ledger,
        { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY, memberId: LAOSAN.id },
        ctx(),
      ),
    ).toThrowError(/停用/)
    expect(() =>
      addExpense(
        ledger,
        { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
        ctx(LAOSAN),
      ),
    ).toThrowError(/停用/)
  })
})

describe('updateExpense / deleteExpense 权限:透明 + 自我编辑', () => {
  it('成员能改自己的,不能改别人的;管理员都能', () => {
    const ledger = fixtureLedger()
    addExpense(ledger, { amountCents: 1000, date: '2026-10-02', categoryId: LUNCH_CATEGORY }, ctx())
    const mine = expenseAt(ledger, '2026-10', 0)
    expect(canEditExpense(XIAOHONG, mine)).toBe(true)
    expect(canEditExpense(ADMIN, mine)).toBe(true)

    const otherLedger = fixtureLedger()
    addExpense(
      otherLedger,
      { amountCents: 500, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      ctx(ADMIN),
    )
    const notMine = expenseAt(otherLedger, '2026-10', 0)
    expect(canEditExpense(XIAOHONG, notMine)).toBe(false)

    expect(() => updateExpense(otherLedger, notMine.id, { note: '偷改' }, ctx())).toThrowError(
      DomainError,
    )
    expect(() => deleteExpense(otherLedger, notMine.id, ctx())).toThrowError(DomainError)

    updateExpense(otherLedger, notMine.id, { amountCents: 600 }, ctx(ADMIN))
    expect(expenseAt(otherLedger, '2026-10', 0).amountCents).toBe(600)
    expect(expenseAt(otherLedger, '2026-10', 0).updatedAt).toBe(NOW)
  })

  it('改日期会把记录搬到新月份,原月份空了就删掉', () => {
    const ledger = fixtureLedger()
    addExpense(ledger, { amountCents: 100, date: '2026-09-30', categoryId: LUNCH_CATEGORY }, ctx())
    const { id } = expenseAt(ledger, '2026-09', 0)

    updateExpense(ledger, id, { date: '2026-10-01' }, ctx())
    expect(ledger.months['2026-09']).toBeUndefined()
    expect(expenseAt(ledger, '2026-10', 0).date).toBe('2026-10-01')
  })

  it('更新后的记录仍通过校验(换分类/金额)', () => {
    const ledger = fixtureLedger()
    addExpense(ledger, { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY }, ctx())
    const { id } = expenseAt(ledger, '2026-10', 0)
    expect(() => updateExpense(ledger, id, { amountCents: -5 }, ctx())).toThrowError(DomainError)
    expect(() => updateExpense(ledger, id, { categoryId: 'cat-dining-3' }, ctx())).not.toThrow()
  })

  it('删除最后一条后该月文件消失', () => {
    const ledger = fixtureLedger()
    addExpense(ledger, { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY }, ctx())
    const { id } = expenseAt(ledger, '2026-10', 0)
    deleteExpense(ledger, id, ctx())
    expect(ledger.months['2026-10']).toBeUndefined()
  })
})
