import { findCategory } from './lookup'
import { isTagColor } from './tags'
import type { Category, CategoryId, LedgerData, Member, TagColor } from './types'
import { DomainError } from './types'

export function isChild(category: Category): boolean {
  return category.parentId !== undefined
}

export function childrenOf(ledger: LedgerData, parentId: CategoryId): Category[] {
  return ledger.meta.categories
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export function parentCategories(ledger: LedgerData): Category[] {
  return ledger.meta.categories.filter((c) => !isChild(c)).sort((a, b) => a.sortOrder - b.sortOrder)
}

export interface CategoryInput {
  id?: CategoryId
  name: string
  parentId?: CategoryId
  sortOrder?: number
  /** 仅父分类可带颜色;7 色调色板之一 */
  color?: TagColor
}

function requireAdmin(actor: Member): void {
  if (actor.role !== 'admin') throw new DomainError('forbidden', '仅管理员可管理分类')
}

function validatedColor(color: TagColor | undefined): TagColor | undefined {
  if (color === undefined) return undefined
  if (!isTagColor(color)) throw new DomainError('invalid_color', `不支持的分类颜色:${color}`)
  return color
}

export function addCategory(ledger: LedgerData, actor: Member, input: CategoryInput): LedgerData {
  requireAdmin(actor)
  if (input.parentId !== undefined) findCategory(ledger, input.parentId)
  if (ledger.meta.categories.some((c) => c.name === input.name && c.parentId === input.parentId)) {
    throw new DomainError('category_duplicated', `同级下已存在同名分类:${input.name}`)
  }
  const sortOrder = input.sortOrder ?? ledger.meta.categories.length
  ledger.meta.categories.push({
    id: input.id ?? `cat-${crypto.randomUUID()}`,
    name: input.name,
    parentId: input.parentId,
    sortOrder,
    color: validatedColor(input.color),
  })
  return ledger
}

export function updateCategory(
  ledger: LedgerData,
  actor: Member,
  id: CategoryId,
  patch: { name?: string; sortOrder?: number; color?: TagColor },
): LedgerData {
  requireAdmin(actor)
  const category = findCategory(ledger, id)
  if (
    patch.name !== undefined &&
    ledger.meta.categories.some(
      (c) => c.id !== id && c.name === patch.name && c.parentId === category.parentId,
    )
  ) {
    throw new DomainError('category_duplicated', `同级下已存在同名分类:${patch.name}`)
  }
  const next = { ...category, ...patch, color: validatedColor(patch.color ?? category.color) }
  ledger.meta.categories = ledger.meta.categories.map((c) => (c.id === id ? next : c))
  return ledger
}

/**
 * 拖拽排序(仅管理员,纯函数):把同一父分类下的子分类(或全部父分类,parentId=null)
 * 按 orderedIds 重写 sortOrder(下标即新位次)。要求 orderedIds 恰好是该层级的完整
 * 集合(成员存在、同父、不重复、不漏项),否则抛 category_reorder_mismatch ——
 * 部分列表会留下未定义顺序,界面拖拽传入的始终是完整层级,严格校验避免脏数据。
 */
export function reorderCategories(
  ledger: LedgerData,
  actor: Member,
  parentId: CategoryId | null,
  orderedIds: readonly CategoryId[],
): LedgerData {
  requireAdmin(actor)
  const siblings = ledger.meta.categories.filter((c) =>
    parentId === null ? !isChild(c) : c.parentId === parentId,
  )
  const siblingIds = new Set(siblings.map((c) => c.id))
  const seen = new Set<CategoryId>()
  for (const id of orderedIds) {
    if (!siblingIds.has(id) || seen.has(id)) {
      throw new DomainError('category_reorder_mismatch', '排序列表必须恰好包含同级全部分类且不重复')
    }
    seen.add(id)
  }
  if (seen.size !== siblingIds.size) {
    throw new DomainError('category_reorder_mismatch', '排序列表必须恰好包含同级全部分类且不重复')
  }
  const orderById = new Map(orderedIds.map((id, index) => [id, index]))
  ledger.meta.categories = ledger.meta.categories.map((c) => {
    const next = orderById.get(c.id)
    return next === undefined ? c : { ...c, sortOrder: next }
  })
  return ledger
}

/**
 * 删除分类。删除仍有支出归属的子分类时,必须提供 migrateToId(同父下的另一个子分类),
 * 该子分类名下的全部支出将迁移过去;父分类必须先删除/迁走其子分类。
 * 迁移会刷新支出的 updatedAt(LWW 需要新时间戳才能把迁移传播到其他设备)。
 */
export function deleteCategory(
  ledger: LedgerData,
  actor: Member,
  id: CategoryId,
  migrateToId?: CategoryId,
  now: string = new Date().toISOString(),
): LedgerData {
  requireAdmin(actor)
  const category = findCategory(ledger, id)

  if (isChild(category)) {
    const inUse = Object.values(ledger.months).some((month) =>
      month.expenses.some((e) => e.categoryId === id),
    )
    if (inUse) {
      if (!migrateToId) throw new DomainError('category_in_use', '该分类下仍有支出,需选择迁移目标')
      const target = findCategory(ledger, migrateToId)
      if (target.parentId !== category.parentId) {
        throw new DomainError('category_migrate_cross_parent', '迁移目标必须属于同一个父分类')
      }
      for (const [monthKey, month] of Object.entries(ledger.months)) {
        if (month.expenses.some((e) => e.categoryId === id)) {
          ledger.months[monthKey] = {
            expenses: month.expenses.map((e) =>
              e.categoryId === id ? { ...e, categoryId: migrateToId, updatedAt: now } : e,
            ),
          }
        }
      }
    }
  } else if (childrenOf(ledger, id).length > 0) {
    throw new DomainError('category_has_children', '请先删除或迁移该分类下的子分类')
  }

  ledger.meta.categories = ledger.meta.categories.filter((c) => c.id !== id)
  return ledger
}
