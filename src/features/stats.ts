/**
 * 统计页的纯逻辑(T10/V9):月/年支出趋势、分类占比(父/子两级、长尾归并)、
 * 标签组/标签占比、成员对比与标签明细。金额均为整数分,月份为 YYYY-MM;
 * 全部为无副作用函数,界面只做展示与 ECharts option 组装。
 */
import {
  aggregateMonth,
  type Category,
  expenseTagIds,
  type LedgerData,
  type MemberId,
  type MonthKey,
  type TagColor,
  type TagGroup,
  type TagId,
} from '../domain'
import { CATEGORY_COLOR_VARS as TAG_COLOR_VARS } from './categories'
import { shiftMonth } from './entries'

export type RangePreset = 'thisMonth' | 'last3Months' | 'last12Months'

/** 图表色板(统计页与首页迷你图共用):CSS chart 令牌,深浅色模式各自适配 */
export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const

/** 按下标循环取色(序号与分类排序解耦);数组恒非空,越界仅作类型兜底 */
export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--tag-gray)'
}

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

/** 标签明细行排序:金额降序 → 名称(中文) → id 稳定兜底 */
function compareTagRows(a: TagDetailRow, b: TagDetailRow): number {
  if (a.totalCents !== b.totalCents) return b.totalCents - a.totalCents
  const byName = NAME_COLLATOR.compare(a.name, b.name)
  if (byName !== 0) return byName
  return a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0
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
 * 子分类展示名(父/子):不同父分类下可能有同名子分类,只显示子分类名会让
 * 环形图分片与图例互相覆盖;父分类缺失时退化为子分类名。
 */
function categoryPathName(categoryById: Map<string, Category>, id: string): string {
  const category = categoryById.get(id)
  if (!category) return '未分类'
  if (category.parentId === undefined) return category.name
  const parent = categoryById.get(category.parentId)
  return parent ? `${parent.name}/${category.name}` : category.name
}

/**
 * 分类占比:level='parent' 把子分类金额聚合到父分类,level='child' 按子分类。
 * 金额降序;超过 topN 的尾部合并为「其他」(id 固定为 MERGED_CATEGORY_ID)。
 * 子级分片用「父/子」全路径名,避免不同父分类下的同名子分类在图表/图例中混淆。
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
    name:
      level === 'child'
        ? categoryPathName(categoryById, id)
        : (categoryById.get(id)?.name ?? '未分类'),
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

/**
 * 下钻:某个父分类下各子分类的占比(金额降序,长尾归并「其他」)。
 * percent 与 categoryShare 同口径(相对范围内全部支出),便于父/子视图对照。
 */
export function categoryChildrenShare(
  ledger: LedgerData,
  months: MonthKey[],
  parentId: string,
  topN = 8,
): CategorySlice[] {
  const children = ledger.meta.categories.filter((category) => category.parentId === parentId)
  const childById = new Map(children.map((category) => [category.id, category]))
  const totals = new Map<string, number>()
  let sumCents = 0

  for (const month of months) {
    for (const expense of ledger.months[month]?.expenses ?? []) {
      sumCents += expense.amountCents
      if (!childById.has(expense.categoryId)) continue
      totals.set(expense.categoryId, (totals.get(expense.categoryId) ?? 0) + expense.amountCents)
    }
  }

  const slices = [...totals.entries()]
    .map(([id, totalCents]) => ({ id, name: childById.get(id)?.name ?? '未分类', totalCents }))
    .sort(compareSlices)

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

/** 合成分组「未分组」的 slice id(展示用,不与真实标签组 id 冲突) */
export const UNGROUPED_GROUP_ID = '__ungrouped__'
/** 未打任何标签的支出合成的「未标记」slice id(保证标签维度环形图总和完整) */
export const UNTAGGED_SLICE_ID = '__untagged__'

export interface TagSlice {
  id: string
  name: string
  totalCents: number
  count: number
  percent: number
  /** CSS 颜色令牌;Chart 组件在 setOption 前解析为具体色值 */
  color: string
}

function tagColorToken(color: TagColor | undefined): string {
  return color === undefined ? 'var(--tag-gray)' : TAG_COLOR_VARS[color]
}

/** 标签维度的取数基础:每个标签与「未标记」的金额/笔数,以及范围内总支出 */
interface TagTotals {
  byTag: Map<TagId, { totalCents: number; count: number }>
  untaggedCents: number
  untaggedCount: number
  sumCents: number
}

/**
 * 汇总范围内支出的标签数据。同一支出的多个标签各计一次(标签是并行维度,
 * 各 slice 之和可以大于总支出);未知/悬空 tagId 静默过滤;无标签计入「未标记」。
 */
function tagTotals(ledger: LedgerData, months: MonthKey[]): TagTotals {
  const known = new Set(ledger.meta.tags.map((tag) => tag.id))
  const byTag = new Map<TagId, { totalCents: number; count: number }>()
  let untaggedCents = 0
  let untaggedCount = 0
  let sumCents = 0

  for (const month of months) {
    for (const expense of ledger.months[month]?.expenses ?? []) {
      sumCents += expense.amountCents
      const ids = [...new Set(expenseTagIds(expense))].filter((id) => known.has(id))
      if (ids.length === 0) {
        untaggedCents += expense.amountCents
        untaggedCount += 1
        continue
      }
      for (const id of ids) {
        const entry = byTag.get(id) ?? { totalCents: 0, count: 0 }
        entry.totalCents += expense.amountCents
        entry.count += 1
        byTag.set(id, entry)
      }
    }
  }
  return { byTag, untaggedCents, untaggedCount, sumCents }
}

function toTagSlice(
  id: string,
  name: string,
  color: string,
  entry: { totalCents: number; count: number },
  sumCents: number,
): TagSlice {
  return {
    id,
    name,
    totalCents: entry.totalCents,
    count: entry.count,
    percent: percentOf(entry.totalCents, sumCents),
    color,
  }
}

function mergeTagTail(slices: TagSlice[], sumCents: number, topN: number): TagSlice[] {
  const limit = Math.max(1, Math.floor(topN))
  const head = slices.slice(0, limit)
  const tail = slices.slice(limit)
  if (tail.length === 0) return head
  const mergedCents = tail.reduce((sum, slice) => sum + slice.totalCents, 0)
  const mergedCount = tail.reduce((sum, slice) => sum + slice.count, 0)
  return [
    ...head,
    {
      id: MERGED_CATEGORY_ID,
      name: '其他',
      totalCents: mergedCents,
      count: mergedCount,
      percent: percentOf(mergedCents, sumCents),
      color: 'var(--tag-gray)',
    },
  ]
}

/**
 * 标签组占比(V9):按标签组聚合金额,标签未归组时归入合成的「未分组」,
 * 没有标签的支出归入「未标记」;金额降序,超过 topN 的尾部合并为「其他」。
 * 每个标签组用组色着色(Chart 解析令牌),未分组/未标记用中性灰。
 */
export function tagGroupSlices(ledger: LedgerData, months: MonthKey[], topN = 8): TagSlice[] {
  const totals = tagTotals(ledger, months)
  const groupOf = new Map<TagId, TagGroup>()
  for (const group of ledger.meta.tagGroups) {
    for (const tagId of group.tagIds) {
      if (!groupOf.has(tagId)) groupOf.set(tagId, group)
    }
  }
  interface Bucket {
    name: string
    color: string
    totalCents: number
    count: number
  }
  const buckets = new Map<string, Bucket>()

  const bucketOf = (id: string, name: string, color: string): Bucket => {
    const existing = buckets.get(id)
    if (existing) return existing
    const created: Bucket = { name, color, totalCents: 0, count: 0 }
    buckets.set(id, created)
    return created
  }

  for (const [tagId, entry] of totals.byTag) {
    const group = groupOf.get(tagId)
    const bucket = group
      ? bucketOf(group.id, group.name, tagColorToken(group.color))
      : bucketOf(UNGROUPED_GROUP_ID, '未分组', tagColorToken(undefined))
    bucket.totalCents += entry.totalCents
    bucket.count += entry.count
  }
  if (totals.untaggedCount > 0) {
    const bucket = bucketOf(UNTAGGED_SLICE_ID, '未标记', 'var(--muted-foreground)')
    bucket.totalCents += totals.untaggedCents
    bucket.count += totals.untaggedCount
  }

  const slices = [...buckets.entries()]
    .map(([id, bucket]) => toTagSlice(id, bucket.name, bucket.color, bucket, totals.sumCents))
    .sort(compareSlices)
  return mergeTagTail(slices, totals.sumCents, topN)
}

/**
 * 下钻:某标签组(或合成的「未分组」)内各标签的占比。
 * 组内标签按金额降序,尾部归并「其他」;组色为该组的颜色。
 */
export function tagSlices(
  ledger: LedgerData,
  months: MonthKey[],
  groupId: string,
  topN = 8,
): TagSlice[] {
  const group =
    groupId === UNGROUPED_GROUP_ID
      ? undefined
      : ledger.meta.tagGroups.find((item) => item.id === groupId)
  if (groupId !== UNGROUPED_GROUP_ID && !group) return []

  const grouped = new Set(ledger.meta.tagGroups.flatMap((item) => item.tagIds))
  const memberTags = ledger.meta.tags.filter((tag) =>
    groupId === UNGROUPED_GROUP_ID
      ? !grouped.has(tag.id)
      : (group?.tagIds.includes(tag.id) ?? false),
  )
  const totals = tagTotals(ledger, months)
  const color = tagColorToken(group?.color)

  const slices = memberTags
    .map((tag) => {
      const entry = totals.byTag.get(tag.id)
      if (!entry) return null
      return toTagSlice(tag.id, tag.name, color, entry, totals.sumCents)
    })
    .filter((slice): slice is TagSlice => slice !== null)
    .sort(compareSlices)
  return mergeTagTail(slices, totals.sumCents, topN)
}

export interface TagDetailRow {
  tagId: TagId
  name: string
  totalCents: number
  count: number
  percent: number
}

export interface TagDetailGroup {
  id: string
  name: string
  color: string
  totalCents: number
  count: number
  rows: TagDetailRow[]
}

/**
 * 标签明细表(V9,标签组维度):按组 → 标签列出金额/笔数/占比,组内标签用完即列。
 * 顺序:组金额降序(未分组合成组殿后);只列范围内实际出现过的标签。
 */
export function tagDetailGroups(ledger: LedgerData, months: MonthKey[]): TagDetailGroup[] {
  const totals = tagTotals(ledger, months)
  const groupOf = new Map<TagId, TagGroup>()
  for (const group of ledger.meta.tagGroups) {
    for (const tagId of group.tagIds) {
      if (!groupOf.has(tagId)) groupOf.set(tagId, group)
    }
  }

  interface DetailBucket {
    id: string
    name: string
    color: string
    totalCents: number
    count: number
    rows: TagDetailRow[]
  }
  const groups = new Map<string, DetailBucket>()

  const bucketOf = (id: string, name: string, color: string): DetailBucket => {
    const existing = groups.get(id)
    if (existing) return existing
    const created: DetailBucket = { id, name, color, totalCents: 0, count: 0, rows: [] }
    groups.set(id, created)
    return created
  }

  for (const tag of ledger.meta.tags) {
    const entry = totals.byTag.get(tag.id)
    if (!entry) continue
    const group = groupOf.get(tag.id)
    const bucket = group
      ? bucketOf(group.id, group.name, tagColorToken(group.color))
      : bucketOf(UNGROUPED_GROUP_ID, '未分组', tagColorToken(undefined))
    bucket.totalCents += entry.totalCents
    bucket.count += entry.count
    bucket.rows.push({
      tagId: tag.id,
      name: tag.name,
      totalCents: entry.totalCents,
      count: entry.count,
      percent: percentOf(entry.totalCents, totals.sumCents),
    })
  }

  return [...groups.values()]
    .map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      color: bucket.color,
      totalCents: bucket.totalCents,
      count: bucket.count,
      rows: [...bucket.rows].sort(compareTagRows),
    }))
    .sort(compareSlices)
}
