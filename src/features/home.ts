/**
 * 首页聚合的纯逻辑(V4):今日/本月汇总、预算小组件、账单流分组、分类色与迷你占比。
 * 全部无副作用;页面只做展示与交互,金额均为整数分。
 */
import {
  aggregateMonth,
  budgetProgress,
  type DateKey,
  type LedgerData,
  type MonthKey,
} from '../domain'
import { type DayGroupEntries, formatDayLabel, groupByDay } from './entries'
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

/**
 * 账单流:全部月份合并后按日期倒序(同日按记录时间、id 兜底),截断后按日分组。
 * 展示行受 limit 截断,但每组的日小计始终按当天全部支出计算(截断只影响列出的行)。
 */
export function homeBillGroups(ledger: LedgerData, limit = HOME_BILL_LIMIT): DayGroupEntries[] {
  const all = Object.values(ledger.months).flatMap((month) => month.expenses)
  all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const groups = groupByDay(ledger, all.slice(0, Math.max(0, limit)))
  const totalByDate = new Map<DateKey, number>()
  for (const expense of all) {
    totalByDate.set(expense.date, (totalByDate.get(expense.date) ?? 0) + expense.amountCents)
  }
  return groups.map((group) => ({
    ...group,
    totalCents: totalByDate.get(group.date) ?? group.totalCents,
  }))
}

/**
 * 日期标签:今天 / 昨天 / M月D日 周X(用于吸顶日期头与今日卡);
 * 与明细页共用 formatDayLabel,仅额外识别今天/昨天。
 */
export function homeDayLabel(date: DateKey, today: DateKey): string {
  if (date === today) return '今天'
  if (date === previousDay(today)) return '昨天'
  return formatDayLabel(date)
}

/**
 * 小组件分页圆点:取离 rail 视口中心最近的子元素下标。
 * railScrollLeft/clientWidth 与每个子元素中心偏移必须处于同一坐标系
 * (相对 rail 滚动内容左缘),空数组回退 0;距离并列时取靠前的下标。
 */
export function activeDotIndex(
  railScrollLeft: number,
  railClientWidth: number,
  childOffsetsRelativeToRail: readonly number[],
): number {
  const center = railScrollLeft + railClientWidth / 2
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  childOffsetsRelativeToRail.forEach((offset, index) => {
    const distance = Math.abs(offset - center)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

function previousDay(date: DateKey): DateKey {
  const parsed = new Date(`${date}T00:00:00`)
  parsed.setDate(parsed.getDate() - 1)
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${parsed.getFullYear()}-${month}-${day}`
}

/** 迷你环形图数据:本月父分类占比(长尾归并为「其他」) */
export function homeDonut(ledger: LedgerData, month: MonthKey, topN = 6): CategorySlice[] {
  return categoryShare(ledger, [month], 'parent', topN)
}
