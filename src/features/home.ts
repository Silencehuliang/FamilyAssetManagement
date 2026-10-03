/**
 * 首页聚合的纯逻辑(V4):今日/本月汇总、预算小组件、账单流分组、分类色与迷你占比。
 * 全部无副作用;页面只做展示与交互,金额均为整数分。
 */
import {
  aggregateMonth,
  budgetProgress,
  type CategoryId,
  type DateKey,
  type LedgerData,
  type MonthKey,
} from '../domain'
import { type DayGroupEntries, groupByDay } from './entries'
import { type CategorySlice, categoryShare } from './stats'

export interface HomeSummary {
  todayTotalCents: number
  todayCount: number
  monthTotalCents: number
  monthCount: number
}

/** 今日与本月汇总(今日取月聚合中的日分组,保证与明细页口径一致) */
export function homeSummary(ledger: LedgerData, today: DateKey): HomeSummary {
  const aggregate = aggregateMonth(ledger, today.slice(0, 7))
  const day = aggregate.days.find((item) => item.date === today)
  return {
    todayTotalCents: day?.totalCents ?? 0,
    todayCount: day?.count ?? 0,
    monthTotalCents: aggregate.totalCents,
    monthCount: aggregate.count,
  }
}

export interface BudgetWidget {
  totalCents: number
  spentCents: number
  remainingCents: number
  overspent: boolean
  /** 0–100,超支截断在 100 */
  percent: number
}

/** 预算进度小组件;未设置总预算时返回 null(界面显示引导) */
export function budgetWidget(ledger: LedgerData, month: MonthKey): BudgetWidget | null {
  const progress = budgetProgress(aggregateMonth(ledger, month), ledger.meta.budgets[month])
  if (!progress.hasTotalBudget) return null
  const percent =
    progress.totalCents > 0
      ? Math.min(100, Math.round((progress.spentCents / progress.totalCents) * 100))
      : 0
  return {
    totalCents: progress.totalCents,
    spentCents: progress.spentCents,
    remainingCents: progress.remainingCents,
    overspent: progress.overspent,
    percent,
  }
}

/** 账单流默认条数上限(避免长账本一次性渲染) */
export const HOME_BILL_LIMIT = 100

/** 账单流:全部月份合并后按日期倒序(同日按记录时间、id 兜底),截断后按日分组 */
export function homeBillGroups(ledger: LedgerData, limit = HOME_BILL_LIMIT): DayGroupEntries[] {
  const all = Object.values(ledger.months).flatMap((month) => month.expenses)
  all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return groupByDay(all.slice(0, Math.max(0, limit)))
}

const WEEKDAYS = '日一二三四五六'

/** 日期标签:今天 / 昨天 / M月D日 周X(用于吸顶日期头与今日卡) */
export function homeDayLabel(date: DateKey, today: DateKey): string {
  if (date === today) return '今天'
  if (date === previousDay(today)) return '昨天'
  const [, month = '', day = ''] = date.split('-')
  const weekday = new Date(`${date}T00:00:00`).getDay()
  return `${Number(month)}月${Number(day)}日 周${WEEKDAYS[weekday] ?? ''}`
}

function previousDay(date: DateKey): DateKey {
  const parsed = new Date(`${date}T00:00:00`)
  parsed.setDate(parsed.getDate() - 1)
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${parsed.getFullYear()}-${month}-${day}`
}

/** 分类色块:父分类按 sortOrder 序号取 chart 色板(确定性);未知分类回退 gray */
export function categoryAccent(ledger: LedgerData, categoryId: CategoryId): string {
  const category = ledger.meta.categories.find((item) => item.id === categoryId)
  const parentId = category?.parentId ?? categoryId
  const parents = ledger.meta.categories
    .filter((item) => item.parentId === undefined)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
  const index = parents.findIndex((item) => item.id === parentId)
  if (index < 0) return 'var(--tag-gray)'
  return `var(--chart-${(index % 8) + 1})`
}

/** 迷你环形图数据:本月父分类占比(长尾归并为「其他」) */
export function homeDonut(ledger: LedgerData, month: MonthKey, topN = 6): CategorySlice[] {
  return categoryShare(ledger, [month], 'parent', topN)
}
