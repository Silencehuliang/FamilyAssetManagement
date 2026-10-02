/**
 * 记一笔的纯逻辑(T6):金额解析、表单 → 领域输入映射、首页汇总与最近记录。
 * 全部为无副作用函数,界面只做状态绑定与展示;校验失败抛 DomainError(带可读文案)。
 */
import {
  aggregateMonth,
  type Category,
  type CategoryId,
  type DateKey,
  DEFAULT_CATEGORIES,
  type Expense,
  type ExpenseInput,
  type LedgerData,
  type MonthKey,
} from '../domain'
import { DomainError } from '../domain/types'

export interface EntryForm {
  /** 用户输入的金额文本(元),如 "12.5" */
  amountText: string
  parentId: string
  categoryId: string
  /** YYYY-MM-DD */
  date: string
  note: string
  /** 逗号/顿号/空格分隔的标签 */
  tagsText: string
  /** 经手人;空串表示默认记录者本人 */
  memberId: string
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 元 → 整数分。接受 "12"、"12.5"、"0.05"、可带 ¥/￥ 与千分位逗号;
 * 拒绝 0、负数、超过两位小数与非法字符。拒绝值一律 invalid_amount。
 */
export function parseAmountToCents(text: string): number {
  const normalized = text.trim().replaceAll(/[¥￥,，\s]/g, '')
  if (!AMOUNT_RE.test(normalized)) {
    throw new DomainError('invalid_amount', '请输入正确的金额,如 12.5')
  }
  const [yuan = '0', fraction = ''] = normalized.split('.')
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) {
    throw new DomainError('invalid_amount', '金额超出可记录范围')
  }
  if (cents <= 0) {
    throw new DomainError('invalid_amount', '金额必须大于 0')
  }
  return cents
}

/** 标签文本 → 去重后的标签数组(逗号/顿号/空白分隔,忽略空串) */
export function splitTags(text: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[,，、\s]+/)) {
    const tag = raw.trim()
    if (tag !== '' && !seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }
  return tags
}

/** 本地时区的今天(YYYY-MM-DD);不用 toISOString,避免时区错位 */
export function todayKey(now: Date = new Date()): DateKey {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 账本无分类时(首次使用/离线首启)以默认分类兜底,保证能立即记账 */
export function ensureCategories(ledger: LedgerData): void {
  if (ledger.meta.categories.length === 0) {
    ledger.meta.categories = structuredClone(DEFAULT_CATEGORIES)
  }
}

/** 分类下拉数据:父分类按 sortOrder,子分类按父分组 */
export function groupCategories(categories: Category[]): {
  parents: Category[]
  childrenByParent: Record<CategoryId, Category[]>
} {
  const parents: Category[] = []
  const childrenByParent: Record<CategoryId, Category[]> = {}
  for (const category of categories) {
    if (category.parentId === undefined) {
      parents.push(category)
    } else {
      const children = childrenByParent[category.parentId] ?? []
      children.push(category)
      childrenByParent[category.parentId] = children
    }
  }
  parents.sort((a, b) => a.sortOrder - b.sortOrder)
  for (const children of Object.values(childrenByParent)) {
    children.sort((a, b) => a.sortOrder - b.sortOrder)
  }
  return { parents, childrenByParent }
}

/**
 * 表单 → 领域输入。校验金额、日期与必选子分类;经手人缺省为记录者本人(代记时显式指定)。
 * 领域层仍会做二道校验(成员存在/启用、金额为正)。
 */
export function buildExpenseInput(
  ledger: LedgerData,
  form: EntryForm,
  defaultMemberId: string,
): ExpenseInput {
  const amountCents = parseAmountToCents(form.amountText)
  const date = form.date.trim()
  if (!DATE_RE.test(date)) {
    throw new DomainError('invalid_date', '请选择有效日期')
  }
  const category = ledger.meta.categories.find((c) => c.id === form.categoryId)
  if (!category) {
    throw new DomainError('unknown_category', '请选择分类')
  }
  if (category.parentId === undefined) {
    throw new DomainError('category_not_leaf', '请选择子分类')
  }
  const note = form.note.trim()
  return {
    amountCents,
    date,
    categoryId: category.id,
    tagNames: splitTags(form.tagsText),
    memberId: form.memberId === '' ? defaultMemberId : form.memberId,
    note: note === '' ? undefined : note,
  }
}

/** 分类名解析:优先账本,回退默认分类(首次播种前的展示) */
export function resolveCategoryName(ledger: LedgerData, id: CategoryId): string {
  const category =
    ledger.meta.categories.find((c) => c.id === id) ?? DEFAULT_CATEGORIES.find((c) => c.id === id)
  return category?.name ?? '未知分类'
}

/** 金额展示:整数分 → "¥12.34" */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export interface MonthSummary {
  monthTotalCents: number
  todayTotalCents: number
  todayCount: number
}

/** 首页汇总:本月累计与今日小计(取自 aggregateMonth 的日分组) */
export function monthSummary(ledger: LedgerData, month: MonthKey, today: DateKey): MonthSummary {
  const aggregate = aggregateMonth(ledger, month)
  const day = aggregate.days.find((d) => d.date === today)
  return {
    monthTotalCents: aggregate.totalCents,
    todayTotalCents: day?.totalCents ?? 0,
    todayCount: day?.count ?? 0,
  }
}

/** 最近 N 笔:按日期倒序,同日按记录时间倒序(稳定到 id) */
export function recentExpenses(ledger: LedgerData, limit: number): Expense[] {
  const all = Object.values(ledger.months).flatMap((month) => month.expenses)
  all.sort((a, b) => {
    if (a.date !== b.date) return b.date < a.date ? -1 : 1
    if (a.createdAt !== b.createdAt) return b.createdAt < a.createdAt ? -1 : 1
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
  })
  return all.slice(0, limit)
}
