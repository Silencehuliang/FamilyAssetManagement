/**
 * 统计页的纯逻辑(T10):月/年支出趋势、分类占比(父/子两级、长尾归并)、成员对比。
 * 金额均为整数分,月份为 YYYY-MM;全部为无副作用函数,界面只做展示。
 */
import { aggregateMonth, type LedgerData, type MemberId, type MonthKey } from '../domain'
import { shiftMonth } from './entries'

export type RangePreset = 'thisMonth' | 'last3Months' | 'last12Months'

export const RANGE_LABELS: Record<RangePreset, string> = {
  thisMonth: '本月',
  last3Months: '近三月',
  last12Months: '近一年',
}

const RANGE_MONTH_COUNT: Record<RangePreset, number> = {
  thisMonth: 1,
  last3Months: 3,
  last12Months: 12,
}

/** 时间范围 → 月份列表(升序,含 anchor 当月) */
export function monthsInRange(anchor: MonthKey, preset: RangePreset): MonthKey[] {
  const count = RANGE_MONTH_COUNT[preset]
  const months: MonthKey[] = []
  for (let back = count - 1; back >= 0; back -= 1) {
    months.push(shiftMonth(anchor, -back))
  }
  return months
}

export interface MonthPoint {
  month: MonthKey
  totalCents: number
  count: number
}

/** 月趋势:给定月份的支出总额与笔数,无数据的月份补零(升序) */
export function monthTrend(ledger: LedgerData, months: MonthKey[]): MonthPoint[] {
  return months.map((month) => {
    const aggregate = aggregateMonth(ledger, month)
    return { month, totalCents: aggregate.totalCents, count: aggregate.count }
  })
}

/** 年视图:anchor 所在自然年的 12 个月(升序,无数据补零) */
export function yearTrend(ledger: LedgerData, anchor: MonthKey): MonthPoint[] {
  const year = anchor.slice(0, 4)
  const months = Array.from(
    { length: 12 },
    (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
  )
  return monthTrend(ledger, months)
}

export type CategoryLevel = 'parent' | 'child'

export interface CategorySlice {
  id: string
  name: string
  totalCents: number
  percent: number
}

/** 长尾归并后的「其他」分片 id(与真实分类 id 隔离) */
export const MERGED_CATEGORY_ID = '__merged_other__'

/** 显式中文排序:仅用于同名金额并列时的稳定次序 */
const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN')

function percentOf(partCents: number, totalCents: number): number {
  if (totalCents <= 0) return 0
  return Math.round((partCents / totalCents) * 1000) / 10
}

function compareSlices(
  a: { totalCents: number; name: string; id: string },
  b: { totalCents: number; name: string; id: string },
): number {
  if (a.totalCents !== b.totalCents) return b.totalCents - a.totalCents
  const byName = NAME_COLLATOR.compare(a.name, b.name)
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 分类占比:level='parent' 把子分类金额聚合到父分类,level='child' 按子分类。
 * 金额降序;超过 topN 的尾部合并为「其他」(id 固定为 MERGED_CATEGORY_ID)。
 */
export function categoryShare(
  ledger: LedgerData,
  months: MonthKey[],
  level: CategoryLevel,
  topN = 8,
): CategorySlice[] {
  const categoryById = new Map(ledger.meta.categories.map((category) => [category.id, category]))
  const totals = new Map<string, number>()
  let sumCents = 0

  for (const month of months) {
    for (const expense of ledger.months[month]?.expenses ?? []) {
      const category = categoryById.get(expense.categoryId)
      const groupId =
        level === 'child' ? expense.categoryId : (category?.parentId ?? expense.categoryId)
      totals.set(groupId, (totals.get(groupId) ?? 0) + expense.amountCents)
      sumCents += expense.amountCents
    }
  }

  const slices = [...totals.entries()].map(([id, totalCents]) => ({
    id,
    name: categoryById.get(id)?.name ?? '未分类',
    totalCents,
  }))
  slices.sort(compareSlices)

  const limit = Math.max(1, Math.floor(topN))
  const head = slices.slice(0, limit)
  const tail = slices.slice(limit)
  const result: CategorySlice[] = head.map((slice) => ({
    ...slice,
    percent: percentOf(slice.totalCents, sumCents),
  }))
  if (tail.length > 0) {
    const mergedCents = tail.reduce((sum, slice) => sum + slice.totalCents, 0)
    result.push({
      id: MERGED_CATEGORY_ID,
      name: '其他',
      totalCents: mergedCents,
      percent: percentOf(mergedCents, sumCents),
    })
  }
  return result
}

export interface MemberSlice {
  id: MemberId
  name: string
  totalCents: number
  count: number
  percent: number
}

/** 成员对比:各成员在范围内的支出金额与份额(金额降序,仅列有支出的成员) */
export function memberShare(ledger: LedgerData, months: MonthKey[]): MemberSlice[] {
  const totals = new Map<MemberId, { totalCents: number; count: number }>()
  let sumCents = 0
  for (const month of months) {
    for (const expense of ledger.months[month]?.expenses ?? []) {
      const entry = totals.get(expense.memberId) ?? { totalCents: 0, count: 0 }
      entry.totalCents += expense.amountCents
      entry.count += 1
      totals.set(expense.memberId, entry)
      sumCents += expense.amountCents
    }
  }

  return [...totals.entries()]
    .map(([id, entry]) => ({
      id,
      name: ledger.meta.members.find((member) => member.id === id)?.displayName ?? '未知成员',
      totalCents: entry.totalCents,
      count: entry.count,
      percent: percentOf(entry.totalCents, sumCents),
    }))
    .sort(compareSlices)
}

/** 趋势序列合计(空状态判断与概览文案用) */
export function trendTotalCents(points: MonthPoint[]): number {
  let total = 0
  for (const point of points) total += point.totalCents
  return total
}
