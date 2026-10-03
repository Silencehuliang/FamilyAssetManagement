/**
 * 明细页的纯逻辑(T7):月份选项、组合筛选、按日分组与汇总、编辑表单回填。
 * 全部为无副作用函数,界面只做状态绑定与展示;金额均为整数分。
 */
import {
  type Category,
  canEditExpense,
  type DateKey,
  type Expense,
  expenseTagIds,
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
 * 标签名字解析(读路径,评审修复):优先按 tagIds 从账本实体解析(未知 id 静默
 * 过滤,删除实体后遗留的引用不显示);一个都解析不到且记录仍带 v1 tagNames 时
 * 回退旧字段 —— 迁移完成前的旧缓存与离线账本仍能正确显示。
 */
function tagNamesOf(ledger: LedgerData, expense: Expense): string[] {
  const names: string[] = []
  for (const id of expenseTagIds(expense)) {
    const tag = ledger.meta.tags.find((item) => item.id === id)
    if (tag) names.push(tag.name)
  }
  if (names.length === 0 && Array.isArray(expense.tagNames)) return [...expense.tagNames]
  return names
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
    const tagNames = tagNamesOf(ledger, expense)
    if (filters.tag !== '' && !tagNames.includes(filters.tag)) return false
    if (keyword !== '') {
      const haystack = [
        expense.note ?? '',
        ...categoryNamesOf(byId.get(expense.categoryId), byId),
        ...tagNames,
      ]
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
}

/**
 * 明细列表条目视图:`tagNames` 由 tagIds 经账本标签实体解析而来(未知 id 过滤),
 * 仅供旧版明细页渲染标签使用;标签体系 UI(V6/V7)直接使用 tagIds/实体后应删除本别名。
 */
export type EntryView = Expense & { tagNames: string[] }

export interface DayGroupEntries {
  date: DateKey
  totalCents: number
  expenses: EntryView[]
}

/** 按日倒序分组;标签名字按账本实体解析;组内按记录时间倒序、id 兜底,保证展示与测试稳定 */
export function groupByDay(ledger: LedgerData, expenses: Expense[]): DayGroupEntries[] {
  const buckets = new Map<DateKey, EntryView[]>()
  for (const expense of expenses) {
    const bucket = buckets.get(expense.date) ?? []
    bucket.push({ ...expense, tagNames: tagNamesOf(ledger, expense) })
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

const WEEKDAYS = '日一二三四五六'

/** 日期标签:M月D日 周X(明细页日分组头与首页非今天/昨天的日期头共用) */
export function formatDayLabel(date: DateKey): string {
  const [, month = '', day = ''] = date.split('-')
  const weekday = new Date(`${date}T00:00:00`).getDay()
  return `${Number(month)}月${Number(day)}日 周${WEEKDAYS[weekday] ?? ''}`
}

export function sumCents(expenses: Expense[]): number {
  let total = 0
  for (const expense of expenses) total += expense.amountCents
  return total
}

/** 该月出现过的全部标签名字,去重升序;由 tagIds 经实体解析(旧字段兜底) */
export function tagsOfMonth(ledger: LedgerData, month: MonthKey): string[] {
  const tags = new Set<string>()
  for (const expense of ledger.months[month]?.expenses ?? []) {
    for (const tag of tagNamesOf(ledger, expense)) tags.add(tag)
  }
  return [...tags].sort((a, b) => TAG_COLLATOR.compare(a, b))
}

/** 显式中文排序:不带 locale 的 localeCompare 随运行环境默认区域变化(CI Ubuntu 与本地 Windows 排序不一致) */
const TAG_COLLATOR = new Intl.Collator('zh-Hans-CN')

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

/** 支出 → 记一笔表单初值(编辑表单回填);分类缺失时父分类留空;标签按实体解析成名字 */
export function expenseToForm(ledger: LedgerData, expense: Expense): EntryForm {
  const category = ledger.meta.categories.find((c) => c.id === expense.categoryId)
  return {
    amountText: formatAmountInput(expense.amountCents),
    parentId: category?.parentId ?? '',
    categoryId: expense.categoryId,
    date: expense.date,
    note: expense.note ?? '',
    tagsText: tagNamesOf(ledger, expense).join(', '),
    memberId: expense.memberId,
  }
}
