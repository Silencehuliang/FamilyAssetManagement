import { describe, expect, it } from 'vitest'
import { aggregateMonth, monthsWithData } from './aggregate'
import { addExpense } from './expenses'
import { ADMIN, fixtureLedger, LUNCH_CATEGORY, NOW, nextId, XIAOHONG } from './fixtures'

function seed() {
  const ledger = fixtureLedger()
  const add = (
    amountCents: number,
    date: string,
    memberId?: string,
    categoryId = LUNCH_CATEGORY,
  ) => {
    addExpense(
      ledger,
      { amountCents, date, categoryId, ...(memberId ? { memberId } : {}) },
      { actor: XIAOHONG, now: NOW, newId: nextId() },
    )
  }
  add(1000, '2026-10-01') // 小红 午餐
  add(2000, '2026-10-01', ADMIN.id) // 阿明 午餐
  add(3000, '2026-10-03') // 小红 午餐
  add(500, '2026-09-28') // 小红 上月
  return ledger
}

describe('aggregateMonth', () => {
  it('总额与笔数只统计当月', () => {
    const agg = aggregateMonth(seed(), '2026-10')
    expect(agg.totalCents).toBe(6000)
    expect(agg.count).toBe(3)
  })

  it('按日分组倒序,含日小计', () => {
    const agg = aggregateMonth(seed(), '2026-10')
    expect(agg.days.map((d) => d.date)).toEqual(['2026-10-03', '2026-10-01'])
    expect(agg.days[0]).toMatchObject({ totalCents: 3000, count: 1 })
    expect(agg.days[1]).toMatchObject({ totalCents: 3000, count: 2 })
  })

  it('按分类与按成员汇总,金额降序、并列时按 id 稳定排序', () => {
    const agg = aggregateMonth(seed(), '2026-10')
    expect(agg.byCategory).toEqual([{ id: LUNCH_CATEGORY, totalCents: 6000, count: 3 }])
    expect(agg.byMember[0]).toMatchObject({ id: XIAOHONG.id, totalCents: 4000, count: 2 })
    expect(agg.byMember[1]).toMatchObject({ id: ADMIN.id, totalCents: 2000, count: 1 })
  })

  it('空月份返回零值结构', () => {
    const agg = aggregateMonth(fixtureLedger(), '2026-01')
    expect(agg).toMatchObject({ totalCents: 0, count: 0, days: [], byCategory: [], byMember: [] })
  })
})

describe('monthsWithData', () => {
  it('倒序列出有数据的月份', () => {
    expect(monthsWithData(seed())).toEqual(['2026-10', '2026-09'])
  })
})
