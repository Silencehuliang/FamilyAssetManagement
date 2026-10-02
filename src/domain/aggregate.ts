import type { CategoryId, LedgerData, MemberId, MonthKey } from './types'

export interface DayGroup {
  date: string
  totalCents: number
  count: number
}

export interface NamedSlice {
  id: string
  totalCents: number
  count: number
}

export interface MonthAggregate {
  month: MonthKey
  totalCents: number
  count: number
  days: DayGroup[]
  byCategory: NamedSlice[]
  byMember: NamedSlice[]
}

export function expensesOfMonth(ledger: LedgerData, month: MonthKey) {
  return ledger.months[month]?.expenses ?? []
}

/** 月度聚合:日小计、按分类、按成员;各分组按金额降序,成员并列时按 id 保证稳定 */
export function aggregateMonth(ledger: LedgerData, month: MonthKey): MonthAggregate {
  const expenses = expensesOfMonth(ledger, month)
  const byDate = new Map<string, DayGroup>()
  const byCategory = new Map<CategoryId, NamedSlice>()
  const byMember = new Map<MemberId, NamedSlice>()
  let totalCents = 0

  for (const e of expenses) {
    totalCents += e.amountCents
    const day = byDate.get(e.date) ?? { date: e.date, totalCents: 0, count: 0 }
    day.totalCents += e.amountCents
    day.count += 1
    byDate.set(e.date, day)

    const cat = byCategory.get(e.categoryId) ?? { id: e.categoryId, totalCents: 0, count: 0 }
    cat.totalCents += e.amountCents
    cat.count += 1
    byCategory.set(e.categoryId, cat)

    const member = byMember.get(e.memberId) ?? { id: e.memberId, totalCents: 0, count: 0 }
    member.totalCents += e.amountCents
    member.count += 1
    byMember.set(e.memberId, member)
  }

  const desc = (a: NamedSlice, b: NamedSlice) =>
    b.totalCents - a.totalCents || a.id.localeCompare(b.id)
  return {
    month,
    totalCents,
    count: expenses.length,
    days: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)),
    byCategory: [...byCategory.values()].sort(desc),
    byMember: [...byMember.values()].sort(desc),
  }
}

/** 有支出数据的月份,倒序 */
export function monthsWithData(ledger: LedgerData): MonthKey[] {
  return Object.keys(ledger.months).sort((a, b) => b.localeCompare(a))
}
