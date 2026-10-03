/**
 * 全屏记账编辑器(V7)的纯逻辑:草稿构建、分类父子点选语义、标签组选择接线、
 * 草稿 → 领域输入/补丁映射。界面只做状态绑定;校验失败抛 DomainError(可读文案)。
 */
import {
  applyTagSelection,
  type Category,
  type CategoryId,
  DEFAULT_CATEGORIES,
  type Expense,
  type ExpenseInput,
  type ExpensePatch,
  isValidAmountCents,
  type LedgerData,
  type MemberId,
  type TagGroup,
  type TagId,
} from '../domain'
import { DomainError } from '../domain/types'
import { groupCategories } from './entry'
import { type FormulaState, formulaAmountCents, formulaFromValue, initialFormula } from './formula'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 编辑器草稿:公式金额 + 分类/标签/日期/备注/经手人 */
export interface EditorDraft {
  formula: FormulaState
  parentId: CategoryId
  categoryId: CategoryId
  /** YYYY-MM-DD */
  date: string
  note: string
  tagIds: TagId[]
  /** 经手人;'' 表示记录者本人 */
  memberId: MemberId | ''
}

/** 账本无分类时(离线首启)用默认分类兜底展示,保存时 controller 会先播种 */
export function editorCategories(ledger: LedgerData): Category[] {
  return ledger.meta.categories.length > 0 ? ledger.meta.categories : DEFAULT_CATEGORIES
}

/** 父分类的第一个子分类(按 sortOrder;我们模型里父分类总带子分类,即 Cent 的 defaultSelect) */
export function defaultChildId(ledger: LedgerData, parentId: CategoryId): CategoryId {
  const { childrenByParent } = groupCategories(editorCategories(ledger))
  return childrenByParent[parentId]?.[0]?.id ?? ''
}

/**
 * 点按父分类的选择语义:当前选中已属于该父分类时保持不动(只切换子分类网格);
 * 否则选中该父分类的第一个子分类。父分类没有子分类时返回 ''(保存会被校验拦下)。
 */
export function selectParentCategory(
  ledger: LedgerData,
  currentCategoryId: CategoryId,
  parentId: CategoryId,
): CategoryId {
  const current = editorCategories(ledger).find((category) => category.id === currentCategoryId)
  if (current?.parentId === parentId) return currentCategoryId
  return defaultChildId(ledger, parentId)
}

/**
 * 新建账单的初始标签选择:每个必选组自动选中第一个标签(组内无标签时规则自动失效)。
 * 再记开新单同样走这里 —— 只清空用户选择,不破坏必选组不变量。
 */
export function initialTagSelection(groups: readonly TagGroup[]): TagId[] {
  const selected: TagId[] = []
  for (const group of groups) {
    if (!group.required) continue
    const first = group.tagIds[0]
    if (first !== undefined && !selected.includes(first)) selected.push(first)
  }
  return selected
}

/**
 * 组内点选:真实组走领域规则(单选替换、必选不可清空最后一个);
 * 合成「未分组」行(group 为 null)是普通切换。
 */
export function toggleTagSelection(
  group: TagGroup | null,
  tagId: TagId,
  currentlySelected: readonly TagId[],
): TagId[] {
  if (group) return applyTagSelection(group, tagId, currentlySelected)
  return currentlySelected.includes(tagId)
    ? currentlySelected.filter((id) => id !== tagId)
    : [...currentlySelected, tagId]
}

/** 新建草稿:金额空、默认分类、必选组自动选中,日期取传入的今天 */
export function draftForNew(ledger: LedgerData, memberId: string, today: string): EditorDraft {
  const { parents, childrenByParent } = groupCategories(editorCategories(ledger))
  const parent = parents[0]
  const child = parent ? childrenByParent[parent.id]?.[0] : undefined
  return {
    formula: initialFormula(),
    parentId: parent?.id ?? '',
    categoryId: child?.id ?? '',
    date: today,
    note: '',
    tagIds: initialTagSelection(ledger.meta.tagGroups),
    memberId,
  }
}

/** 编辑草稿:从既有支出预填(公式显示为普通金额;标签按 id 过滤未知引用) */
export function draftFromExpense(
  ledger: LedgerData,
  expense: Expense,
  fallbackMemberId: string,
): EditorDraft {
  const category = ledger.meta.categories.find((item) => item.id === expense.categoryId)
  const known = new Set(ledger.meta.tags.map((tag) => tag.id))
  return {
    formula: formulaFromValue(expense.amountCents / 100),
    parentId: category?.parentId ?? '',
    categoryId: expense.categoryId,
    date: expense.date,
    note: expense.note ?? '',
    tagIds: (Array.isArray(expense.tagIds) ? expense.tagIds : []).filter((id) => known.has(id)),
    memberId: expense.memberId || fallbackMemberId,
  }
}

/** 再记:保存后开新单,仅保留日期(金额归零、默认分类、必选标签自动选中) */
export function draftForAgain(ledger: LedgerData, memberId: string, date: string): EditorDraft {
  return { ...draftForNew(ledger, memberId, date) }
}

function assertDraftFields(
  ledger: LedgerData,
  draft: EditorDraft,
): { amountCents: number; note: string } {
  const amountCents = formulaAmountCents(draft.formula)
  if (amountCents <= 0) throw new DomainError('invalid_amount', '请输入大于 0 的金额')
  if (!isValidAmountCents(amountCents)) throw new DomainError('invalid_amount', '金额超出上限')
  if (!DATE_RE.test(draft.date)) throw new DomainError('invalid_date', '请选择有效日期')
  const category = editorCategories(ledger).find((item) => item.id === draft.categoryId)
  if (!category) throw new DomainError('unknown_category', '请选择分类')
  if (category.parentId === undefined) throw new DomainError('category_not_leaf', '请选择子分类')
  return { amountCents, note: draft.note.trim() }
}

function uniqueIds(ids: readonly TagId[]): TagId[] {
  const result: TagId[] = []
  for (const id of ids) if (!result.includes(id)) result.push(id)
  return result
}

/** 草稿 → 新增支出输入(经手人空串 = 记录者本人;标签直接走实体 id) */
export function buildEditorExpenseInput(ledger: LedgerData, draft: EditorDraft): ExpenseInput {
  const { amountCents, note } = assertDraftFields(ledger, draft)
  return {
    amountCents,
    date: draft.date,
    categoryId: draft.categoryId,
    tagIds: uniqueIds(draft.tagIds),
    memberId: draft.memberId === '' ? undefined : draft.memberId,
    note: note === '' ? undefined : note,
  }
}

/** 草稿 → 更新补丁(备注清空传 null;成员空串表示不改归属) */
export function buildEditorExpensePatch(ledger: LedgerData, draft: EditorDraft): ExpensePatch {
  const { amountCents, note } = assertDraftFields(ledger, draft)
  return {
    amountCents,
    date: draft.date,
    categoryId: draft.categoryId,
    tagIds: uniqueIds(draft.tagIds),
    memberId: draft.memberId === '' ? undefined : draft.memberId,
    note: note === '' ? null : note,
  }
}
