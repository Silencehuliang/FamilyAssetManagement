/**
 * 明细页的纯逻辑(T7):月份选项、组合筛选、按日分组与汇总、编辑表单回填。
 * 全部为无副作用函数,界面只做状态绑定与展示;金额均为整数分。
 */
import {
  type Category,
  canEditExpense,
  type DateKey,
  type Expense,
  type LedgerData,
  type Member,
  type MemberId,
  type MonthKey,
} from '../domain'
import type { EntryForm } from './entry'

export interface EntryFilters {
  /** 父分类 id;'' 表示不限 */
  parentId: string
  /** 子分类 id;'' 表示不限(仅父分类时匹配其全部子分类) */
  categoryId: string
  /** 经手人 id;'' 表示不限 */
  memberId: string
  /** 精确标签;'' 表示不限 */
  tag: string
  /** 关键词:备注/分类名/标签的子串,忽略大小写 */
  keyword: string
}

export const EMPTY_FILTERS: EntryFilters = {
  parentId: '',
  categoryId: '',
  memberId: '',
  tag: '',
  keyword: '',
}

export function hasActiveFilters(filters: EntryFilters): boolean {
  return (
    filters.parentId !== '' ||
    filters.categoryId !== '' ||
    filters.memberId !== '' ||
    filters.tag !== '' ||
    filters.keyword.trim() !== ''
  )
}

function categoryById(ledger: LedgerData): Map<string, Category> {
  return new Map(ledger.meta.categories.map((c) => [c.id, c]))
}

function categoryNamesOf(category: Category | undefined, byId: Map<string, Category>): string[] {
  if (!category) return []
  if (category.parentId === undefined) return [category.name]
  return [byId.get(category.parentId)?.name ?? '', category.name].filter((name) => name !== '')
}

/**
 * 组合筛选:分类(父/子)、成员、标签、关键词,彼此为「与」关系。
 * 关键词命中备注、分类名(含父分类)或任一标签的子串(忽略大小写)。
 */
export function filterExpenses(
  ledger: LedgerData,
  expenses: Expense[],
  filters: EntryFilters,
): Expense[] {
  const byId = categoryById(ledger)
  const keyword = filters.keyword.trim().toLowerCase()
  return expenses.filter((expense) => {
    if (filters.categoryId !== '' && expense.categoryId !== filters.categoryId) return false
    if (filters.categoryId === '' && filters.parentId !== '') {
      const category = byId.get(expense.categoryId)
      if (category?.parentId !== filters.parentId) return false
    }
    if (filters.memberId !== '' && expense.memberId !== filters.memberId) return false
    if (filters.tag !== '' && !expense.tagNames.includes(filters.tag)) return false
    if (keyword !== '') {
      const haystack = [
        expense.note ?? '',
        ...categoryNamesOf(byId.get(expense.categoryId), byId),
        ...expense.tagNames,
      ]
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
}

export interface DayGroupEntries {
  date: DateKey
  totalCents: number
  expenses: Expense[]
}

/** 按日倒序分组;组内按记录时间倒序、id 兜底,保证展示与测试稳定 */
export function groupByDay(expenses: Expense[]): DayGroupEntries[] {
  const buckets = new Map<DateKey, Expense[]>()
  for (const expense of expenses) {
    const bucket = buckets.get(expense.date) ?? []
    bucket.push(expense)
    buckets.set(expense.date, bucket)
  }
  const groups: DayGroupEntries[] = []
  for (const date of [...buckets.keys()].sort((a, b) => b.localeCompare(a))) {
    const bucket = buckets.get(date)
    if (!bucket || bucket.length === 0) continue
    bucket.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    let totalCents = 0
    for (const expense of bucket) totalCents += expense.amountCents
    groups.push({ date, totalCents, expenses: bucket })
  }
  return groups
}

export function sumCents(expenses: Expense[]): number {
  let total = 0
  for (const expense of expenses) total += expense.amountCents
  return total
}

/** 该月出现过的全部标签,去重升序;供标签筛选下拉 */
export function tagsOfMonth(ledger: LedgerData, month: MonthKey): string[] {
  const tags = new Set<string>()
  for (const expense of ledger.months[month]?.expenses ?? []) {
    for (const tag of expense.tagNames) tags.add(tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b))
}

export interface MonthOption {
  month: MonthKey
  hasData: boolean
  label: string
}

/** 月份选择项:有数据的月份 ∪ 当前月 ∪ 当前选中月,倒序;有数据的月份供界面高亮 */
export function monthOptions(
  ledger: LedgerData,
  selectedMonth: MonthKey,
  currentMonth: MonthKey,
): MonthOption[] {
  const months = new Set<MonthKey>([selectedMonth, currentMonth, ...Object.keys(ledger.months)])
  return [...months]
    .sort((a, b) => b.localeCompare(a))
    .map((month) => ({
      month,
      hasData: (ledger.months[month]?.expenses.length ?? 0) > 0,
      label: formatMonthLabel(month),
    }))
}

export function formatMonthLabel(month: MonthKey): string {
  const [year = '', m = ''] = month.split('-')
  return `${year}年${Number(m)}月`
}

/** 月份平移(跨年前后),如 shiftMonth('2026-01', -1) === '2025-12' */
export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [year = '1970', m = '1'] = month.split('-')
  const total = Number(year) * 12 + (Number(m) - 1) + delta
  const nextYear = Math.floor(total / 12)
  const nextMonth = total - nextYear * 12 + 1
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`
}

export function memberNameOf(ledger: LedgerData, id: MemberId): string {
  return ledger.meta.members.find((m) => m.id === id)?.displayName ?? '未知成员'
}

/** 明细中的编辑/删除入口是否可用(管理员、经手人或记录者);界面不得向他人提供入口 */
export function canEditEntry(actor: Member, expense: Expense): boolean {
  return canEditExpense(actor, expense)
}

/** 整数分 → 金额输入框文本(如 1250 → "12.5",1205 → "12.05") */
export function formatAmountInput(cents: number): string {
  const yuan = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, '0')
  if (fraction === '00') return String(yuan)
  if (fraction.endsWith('0')) return `${yuan}.${fraction[0]}`
  return `${yuan}.${fraction}`
}

/** 支出 → 记一笔表单初值(编辑表单回填);分类缺失时父分类留空 */
export function expenseToForm(ledger: LedgerData, expense: Expense): EntryForm {
  const category = ledger.meta.categories.find((c) => c.id === expense.categoryId)
  return {
    amountText: formatAmountInput(expense.amountCents),
    parentId: category?.parentId ?? '',
    categoryId: expense.categoryId,
    date: expense.date,
    note: expense.note ?? '',
    tagsText: expense.tagNames.join(', '),
    memberId: expense.memberId,
  }
}
