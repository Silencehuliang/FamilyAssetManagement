/**
 * 分类管理页的纯逻辑(T8/V8):两级树、排序位次、使用量统计、颜色解析与管理员门禁。
 * 领域层(categories.ts)负责增删改与迁移/排序规则,这里只做界面展示所需的无副作用计算。
 */
import type { Category, CategoryId, LedgerData, Member, TagColor } from '../domain'
import { childrenOf, isChild, parentCategories } from '../domain'

export interface CategoryTreeNode {
  parent: Category
  children: Category[]
}

/** 两级分类树:父分类与其子分类均按 sortOrder(同序按 id)排列,尊重自定义顺序 */
export function categoryTree(ledger: LedgerData): CategoryTreeNode[] {
  return parentCategories(ledger).map((parent) => ({
    parent,
    children: childrenOf(ledger, parent.id),
  }))
}

/** 分类颜色令牌:7 色与标签组共用同一词汇(ADR-0006) */
export const CATEGORY_COLOR_VARS: Record<TagColor, string> = {
  red: 'var(--tag-red)',
  orange: 'var(--tag-orange)',
  yellow: 'var(--tag-yellow)',
  green: 'var(--tag-green)',
  blue: 'var(--tag-blue)',
  purple: 'var(--tag-purple)',
  gray: 'var(--tag-gray)',
}

/** 分类所属的父分类(父分类返回自身;未知 id 返回 undefined) */
export function categoryParent(ledger: LedgerData, categoryId: CategoryId): Category | undefined {
  const category = ledger.meta.categories.find((c) => c.id === categoryId)
  if (!category) return undefined
  if (category.parentId === undefined) return category
  return ledger.meta.categories.find((c) => c.id === category.parentId)
}

/**
 * 分类色(V8,供管理页/明细/首页/图表统一取色):
 * 1. 父分类选了 7 色之一 → 对应 --tag-* 令牌(子分类继承父分类色);
 * 2. 未选色 → 按父分类在 sortOrder 中的序号取 chart 色板(确定性回退,与原 categoryAccent 一致);
 * 3. 未知分类 → gray。
 */
export function categoryColor(ledger: LedgerData, categoryId: CategoryId): string {
  const parent = categoryParent(ledger, categoryId)
  if (!parent) return 'var(--tag-gray)'
  if (parent.color !== undefined) return CATEGORY_COLOR_VARS[parent.color]
  const index = parentCategories(ledger).findIndex((c) => c.id === parent.id)
  if (index < 0) return 'var(--tag-gray)'
  return `var(--chart-${(index % 8) + 1})`
}

/** 下一个排序位次:同级最大 sortOrder + 1(空集合从 0 开始) */
export function nextSortOrder(ledger: LedgerData, parentId?: CategoryId): number {
  const siblings = parentId === undefined ? parentCategories(ledger) : childrenOf(ledger, parentId)
  let max = -1
  for (const sibling of siblings) {
    if (sibling.sortOrder > max) max = sibling.sortOrder
  }
  return max + 1
}

/** 同父下的其他子分类;删除有支出的子分类时作为迁移候选 */
export function migrationTargets(ledger: LedgerData, id: CategoryId): Category[] {
  const category = ledger.meta.categories.find((c) => c.id === id)
  if (!category || !isChild(category)) return []
  return childrenOf(ledger, category.parentId ?? '').filter((c) => c.id !== id)
}

/** 该分类(含子分类)名下的支出笔数;删除前判断是否需要迁移 */
export function countExpensesInCategory(ledger: LedgerData, id: CategoryId): number {
  let count = 0
  for (const month of Object.values(ledger.months)) {
    for (const expense of month.expenses) {
      if (expense.categoryId === id) count += 1
    }
  }
  return count
}

/** 分类是否仍被支出引用(子分类删除需迁移) */
export function categoryInUse(ledger: LedgerData, id: CategoryId): boolean {
  return countExpensesInCategory(ledger, id) > 0
}

/** 仅管理员可管理分类;普通成员在界面上只读 */
export function canManageCategories(actor: Member | null): boolean {
  return actor?.role === 'admin'
}
