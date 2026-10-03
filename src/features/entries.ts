/**
 * 明细页的纯逻辑(T7/V10):月份选项、组合筛选、按日分组与汇总、编辑表单回填。
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
  type TagColor,
  type TagGroup,
  type TagId,
} from '../domain'
import type { EntryForm } from './entry'
import { resolveExpenseTagNames } from './tags'

export type TagFilterMode = 'include' | 'exclude'

export interface EntryFilters {
  /** 父分类 id;'' 表示不限 */
  parentId: string
  /** 子分类 id;'' 表示不限(仅父分类时匹配其全部子分类) */
  categoryId: string
  /** 经手人 id;'' 表示不限 */
  memberId: string
  /** 选中的标签实体 id(空数组表示不限) */
  tagIds: TagId[]
  /** include:含任一选中标签;exclude:剔除带任一选中标签的支出 */
  tagMode: TagFilterMode
  /** 关键词:备注/分类名/标签的子串,忽略大小写 */
  keyword: string
}

export const EMPTY_FILTERS: EntryFilters = {
  parentId: '',
  categoryId: '',
  memberId: '',
  tagIds: [],
  tagMode: 'include',
  keyword: '',
}

export function hasActiveFilters(filters: EntryFilters): boolean {
  return (
    filters.parentId !== '' ||
    filters.categoryId !== '' ||
    filters.memberId !== '' ||
    filters.tagIds.length > 0 ||
    filters.keyword.trim() !== ''
  )
}

/** 标签筛选是否参与(空选择时 include/exclude 都视为不限) */
export function hasTagFilter(filters: EntryFilters): boolean {
  return filters.tagIds.length > 0
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
 * 标签实体 id 解析(筛选路径,V10):只保留存在于账本的实体(悬空引用过滤);
 * 旧记录仅有 tagNames 时按名字映射到同名实体,保证迁移前也能按 id 筛选。
 */
function resolvedTagIdsOf(ledger: LedgerData, expense: Expense): TagId[] {
  const known = new Set(ledger.meta.tags.map((tag) => tag.id))
  const ids = expenseTagIds(expense).filter((id) => known.has(id))
  if (ids.length > 0) return ids
  if (!Array.isArray(expense.tagNames)) return ids
  const byName = new Map(ledger.meta.tags.map((tag) => [tag.name, tag.id]))
  const fallback: TagId[] = []
  for (const name of expense.tagNames) {
    const id = byName.get(name)
    if (id !== undefined && !fallback.includes(id)) fallback.push(id)
  }
  return fallback
}

/** 行内标签 chip:标签实体 + 所属标签组颜色(V10;未归组/旧数据为 undefined) */
export interface EntryTagChip {
  id: TagId
  name: string
  color?: TagColor
}

/** 该标签所属的标签组(第一个包含它的组;未归组返回 undefined) */
function groupOfTag(ledger: LedgerData, tagId: TagId): TagGroup | undefined {
  return ledger.meta.tagGroups.find((group) => group.tagIds.includes(tagId))
}

/**
 * 明细/首页行内 chips:优先 tagIds → 实体(带组色);旧记录仅有 tagNames 时
 * 按名字回退(找不到实体则无色 chip,id 用名字占位)。
 */
export function tagChipsOf(ledger: LedgerData, expense: Expense): EntryTagChip[] {
  const chips: EntryTagChip[] = []
  const seen = new Set<string>()
  for (const id of expenseTagIds(expense)) {
    const tag = ledger.meta.tags.find((item) => item.id === id)
    if (!tag || seen.has(tag.id)) continue
    seen.add(tag.id)
    const color = groupOfTag(ledger, tag.id)?.color
    chips.push(
      color === undefined ? { id: tag.id, name: tag.name } : { id: tag.id, name: tag.name, color },
    )
  }
  if (chips.length === 0 && Array.isArray(expense.tagNames)) {
    for (const name of expense.tagNames) {
      if (seen.has(name)) continue
      seen.add(name)
      const tag = ledger.meta.tags.find((item) => item.name === name)
      const color = tag ? groupOfTag(ledger, tag.id)?.color : undefined
      // 有同名实体时用实体 id(chip 可追溯到标签),否则退化为名字占位
      const id = tag?.id ?? name
      chips.push(color === undefined ? { id, name } : { id, name, color })
    }
  }
  return chips
}

/**
 * 组合筛选:分类(父/子)、成员、标签(含/排除)、关键词,彼此为「与」关系;
 * 标签模式下 include = 含任一选中标签,exclude = 剔除带任一选中标签的支出。
 * 关键词命中备注、分类名(含父分类)或任一标签的子串(忽略大小写)。
 * 标签名字统一由 features/tags.ts 的 `resolveExpenseTagNames` 解析(实体优先,旧字段兜底)。
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
    const tagNames = resolveExpenseTagNames(ledger, expense)
    if (filters.tagIds.length > 0) {
      const ids = resolvedTagIdsOf(ledger, expense)
      const matched = filters.tagIds.some((id) => ids.includes(id))
      if (filters.tagMode === 'include' ? !matched : matched) return false
    }
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
 * 明细列表条目视图:`tagNames`/`tagChips` 由 tagIds 经账本标签实体解析而来
 * (未知 id 过滤);标签 chips 带所属标签组颜色供行内着色。
 */
export type EntryView = Expense & { tagNames: string[]; tagChips: EntryTagChip[] }

export interface DayGroupEntries {
  date: DateKey
  totalCents: number
  expenses: EntryView[]
}

/** 按日倒序分组;标签名字/组色 chips 按账本实体解析;组内按记录时间倒序、id 兜底,保证展示与测试稳定 */
export function groupByDay(ledger: LedgerData, expenses: Expense[]): DayGroupEntries[] {
  const buckets = new Map<DateKey, EntryView[]>()
  for (const expense of expenses) {
    const bucket = buckets.get(expense.date) ?? []
    bucket.push({
      ...expense,
      tagNames: resolveExpenseTagNames(ledger, expense),
      tagChips: tagChipsOf(ledger, expense),
    })
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
    for (const tag of resolveExpenseTagNames(ledger, expense)) tags.add(tag)
  }
  return [...tags].sort((a, b) => TAG_COLLATOR.compare(a, b))
}

/** 显式中文排序:不带 locale 的 localeCompare 随运行环境默认区域变化(CI Ubuntu 与本地 Windows 排序不一致) */
const TAG_COLLATOR = new Intl.Collator('zh-Hans-CN')

/** 筛选区「未分组」合成组的 id(展示用,不与真实标签组 id 冲突) */
export const UNGROUPED_FILTER_GROUP_ID = '__ungrouped_filter__'

/** 筛选区标签组:组名 + 组色 + 该月实际用到的标签(供分组 chips 渲染) */
export interface TagFilterGroup {
  id: string
  name: string
  color?: TagColor
  tags: Array<{ id: TagId; name: string }>
}

/**
 * 按标签组分组的筛选选项(V10):只列所选月份实际出现过的标签实体;
 * 未归组的标签合成「未分组」组(按名称中文排序);悬空引用忽略。
 */
export function tagFilterGroups(ledger: LedgerData, month: MonthKey): TagFilterGroup[] {
  const used = new Set<TagId>()
  for (const expense of ledger.months[month]?.expenses ?? []) {
    for (const id of resolvedTagIdsOf(ledger, expense)) used.add(id)
  }
  if (used.size === 0) return []

  const result: TagFilterGroup[] = []
  for (const group of ledger.meta.tagGroups) {
    const tags = group.tagIds.flatMap((id) => {
      if (!used.has(id)) return []
      const tag = ledger.meta.tags.find((item) => item.id === id)
      return tag ? [{ id: tag.id, name: tag.name }] : []
    })
    if (tags.length > 0) {
      result.push({ id: group.id, name: group.name, color: group.color, tags })
    }
  }

  const grouped = new Set(ledger.meta.tagGroups.flatMap((group) => group.tagIds))
  const ungrouped = ledger.meta.tags
    .filter((tag) => used.has(tag.id) && !grouped.has(tag.id))
    .map((tag) => ({ id: tag.id, name: tag.name }))
    .sort((a, b) => TAG_COLLATOR.compare(a.name, b.name))
  if (ungrouped.length > 0) {
    result.push({ id: UNGROUPED_FILTER_GROUP_ID, name: '未分组', tags: ungrouped })
  }
  return result
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

/** 支出 → 记一笔表单初值(编辑表单回填);分类缺失时父分类留空;标签按实体解析成名字 */
export function expenseToForm(ledger: LedgerData, expense: Expense): EntryForm {
  const category = ledger.meta.categories.find((c) => c.id === expense.categoryId)
  return {
    amountText: formatAmountInput(expense.amountCents),
    parentId: category?.parentId ?? '',
    categoryId: expense.categoryId,
    date: expense.date,
    note: expense.note ?? '',
    tagsText: resolveExpenseTagNames(ledger, expense).join(', '),
    memberId: expense.memberId,
  }
}
