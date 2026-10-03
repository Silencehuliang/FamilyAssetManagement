/**
 * 标签管理界面(V6)与标签选择(V7)共用的纯逻辑:引用计数、分组视图、
 * 排序与颜色令牌映射。全部无副作用,界面只做状态绑定与展示。
 */
import {
  type Expense,
  expenseTagIds,
  type LedgerData,
  synthesizeUngrouped,
  TAG_PALETTE,
  type Tag,
  type TagColor,
  type TagGroup,
  type TagGroupId,
  type TagId,
} from '../domain'

/** 该标签被多少笔支出引用(删除确认「将清理 N 笔支出中的引用」用) */
export function tagUsageCount(ledger: LedgerData, tagId: TagId): number {
  let count = 0
  for (const data of Object.values(ledger.months)) {
    for (const expense of data.expenses) {
      if (expenseTagIds(expense).includes(tagId)) count += 1
    }
  }
  return count
}

/**
 * 支出携带的标签名字(读路径,唯一实现):按 tagIds 从账本实体解析,未知 id 静默过滤;
 * 一个都解析不到且记录仍带 v1 tagNames 时回退旧字段(迁移完成前的旧缓存)。
 * 首页/明细页/编辑回填共用本函数(评审修复:原 features/entries.ts 有一份逐字重复)。
 */
export function resolveExpenseTagNames(ledger: LedgerData, expense: Expense): string[] {
  const names: string[] = []
  for (const id of expenseTagIds(expense)) {
    const tag = ledger.meta.tags.find((item) => item.id === id)
    if (tag) names.push(tag.name)
  }
  if (names.length === 0 && Array.isArray(expense.tagNames)) return [...expense.tagNames]
  return names
}

/**
 * 标签组的排序位次:缺省(旧数据)按 0 参与排序。
 * 与 `nextTagGroupSortOrder` 共用本函数,保证「新建组取最大 +1」与展示排序对
 * undefined 的处理一致(#29 评审修复:曾出现新组排到旧的无序组之前)。
 */
export function tagGroupSortOrder(group: TagGroup): number {
  return group.sortOrder ?? 0
}

/** 标签组展示排序比较器(sortOrder 升序,缺省按 0);稳定排序保持同档的数组原序 */
export function compareTagGroups(a: TagGroup, b: TagGroup): number {
  return tagGroupSortOrder(a) - tagGroupSortOrder(b)
}

/** 下一个可用的组排序位次:所有组(缺省按 0)最大 +1,保证新组排在既有组之后 */
export function nextTagGroupSortOrder(groups: readonly TagGroup[]): number {
  let max = -1
  for (const group of groups) max = Math.max(max, tagGroupSortOrder(group))
  return max + 1
}

/** 标签组的展示顺序:sortOrder 升序,缺省(旧数据)按 0,与新建组的位次规则一致 */
export function sortedTagGroups(groups: readonly TagGroup[]): TagGroup[] {
  return [...groups].sort(compareTagGroups)
}

/** 标签管理对话框的一段:组 + 组内标签(按组 tagIds 顺序,未知 id 过滤) */
export interface TagGroupSection {
  group: TagGroup
  tags: Tag[]
}

export interface TagManagerSections {
  /** 不属于任何组的标签(合成分组,按 id 升序) */
  ungrouped: Tag[]
  /** 各标签组,按 sortOrder 展示 */
  groups: TagGroupSection[]
}

/** 组装标签管理界面的分区数据(未分组 + 各组) */
export function tagManagerSections(ledger: LedgerData): TagManagerSections {
  const { tags, tagGroups } = ledger.meta
  return {
    ungrouped: synthesizeUngrouped(tags, tagGroups),
    groups: sortedTagGroups(tagGroups).map((group) => ({
      group,
      tags: group.tagIds
        .map((id) => tags.find((tag) => tag.id === id))
        .filter((tag): tag is Tag => tag !== undefined),
    })),
  }
}

/** 记账编辑器的标签行:每个真实组一行,未分组(有标签时)合成最后一行 */
export interface TagSelectionRow {
  /** null 表示合成的「未分组」行 */
  group: TagGroup | null
  label: string
  color: TagColor
  tags: Tag[]
}

export function tagSelectionRows(ledger: LedgerData): TagSelectionRow[] {
  const sections = tagManagerSections(ledger)
  const rows: TagSelectionRow[] = sections.groups.map(({ group, tags }) => ({
    group,
    label: group.name,
    color: group.color,
    tags,
  }))
  if (sections.ungrouped.length > 0) {
    rows.push({ group: null, label: '未分组', color: UNGROUPED_COLOR, tags: sections.ungrouped })
  }
  return rows
}

/**
 * 列表内移动一项(上/下移),越界返回原数组的拷贝。
 * 用于标签组的简单排序按钮(不引入拖拽库)。
 */
export function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
  const next = [...items]
  const target = index + delta
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next
  const [item] = next.splice(index, 1)
  if (item === undefined) return next
  next.splice(target, 0, item)
  return next
}

/** 标签组排序 id 列表上移一位(管理界面把结果交给 controller.reorderTagGroups) */
export function moveGroupId(
  ids: readonly TagGroupId[],
  id: TagGroupId,
  delta: number,
): TagGroupId[] {
  const index = ids.indexOf(id)
  if (index < 0) return [...ids]
  return moveItem(ids, index, delta)
}

/**
 * 颜色令牌 → Tailwind 类名(静态字面量,保证扫描器收录)。
 * chip 默认态为浅色底 + 同色文字与边框,选中态为实色底 + 白字。
 */
export const TAG_CHIP_CLASS: Record<TagColor, string> = {
  red: 'border-tag-red/40 bg-tag-red/10 text-tag-red',
  orange: 'border-tag-orange/40 bg-tag-orange/10 text-tag-orange',
  yellow: 'border-tag-yellow/50 bg-tag-yellow/10 text-amber-600',
  green: 'border-tag-green/40 bg-tag-green/10 text-tag-green',
  blue: 'border-tag-blue/40 bg-tag-blue/10 text-tag-blue',
  purple: 'border-tag-purple/40 bg-tag-purple/10 text-tag-purple',
  gray: 'border-tag-gray/40 bg-tag-gray/10 text-tag-gray',
}

export const TAG_CHIP_ACTIVE_CLASS: Record<TagColor, string> = {
  red: 'border-tag-red bg-tag-red text-white',
  orange: 'border-tag-orange bg-tag-orange text-white',
  yellow: 'border-tag-yellow bg-tag-yellow text-stone-900',
  green: 'border-tag-green bg-tag-green text-white',
  blue: 'border-tag-blue bg-tag-blue text-white',
  purple: 'border-tag-purple bg-tag-purple text-white',
  gray: 'border-tag-gray bg-tag-gray text-white',
}

export const TAG_DOT_CLASS: Record<TagColor, string> = {
  red: 'bg-tag-red',
  orange: 'bg-tag-orange',
  yellow: 'bg-tag-yellow',
  green: 'bg-tag-green',
  blue: 'bg-tag-blue',
  purple: 'bg-tag-purple',
  gray: 'bg-tag-gray',
}

/** 色板 swatch 的选中态外圈色(标签组编辑的 7 色选择) */
export const TAG_SWATCH_ACTIVE_CLASS: Record<TagColor, string> = {
  red: 'ring-tag-red',
  orange: 'ring-tag-orange',
  yellow: 'ring-tag-yellow',
  green: 'ring-tag-green',
  blue: 'ring-tag-blue',
  purple: 'ring-tag-purple',
  gray: 'ring-tag-gray',
}

/** 未分组标签使用中性灰着色(没有所属组的颜色) */
export const UNGROUPED_COLOR: TagColor = 'gray'

export { TAG_PALETTE }
