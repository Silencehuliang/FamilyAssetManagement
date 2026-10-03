import { findCategory, findMember } from './lookup'
import { findTag } from './tags'
import type {
  Category,
  DateKey,
  Expense,
  ExpenseId,
  LedgerData,
  Member,
  MemberId,
  MonthKey,
} from './types'
import { DomainError } from './types'

export interface ExpenseInput {
  amountCents: number
  date: DateKey
  categoryId: Category['id']
  /** 标签实体 id(新模型);与 tagNames 同时给出时以本字段为准 */
  tagIds?: string[]
  /**
   * @deprecated v1 自由标签文本;兼容旧界面写入,由迁移引擎在同步时
   * 转换为 tagIds(见 src/domain/tag-migration.ts)。
   */
  tagNames?: string[]
  /** 经手人,缺省为记录者本人(代记时指定他人) */
  memberId?: Member['id']
  note?: string
}

export interface ExpensePatch {
  amountCents?: number
  date?: DateKey
  categoryId?: Category['id']
  /** 标签实体 id(新模型);给出即整体替换并丢弃废弃的 tagNames */
  tagIds?: string[]
  /** @deprecated v1 自由标签文本;给出即整体替换,由迁移引擎转换为 tagIds */
  tagNames?: string[]
  /** 修正经手人(记错代记对象时) */
  memberId?: MemberId
  /** 传 null 清除备注;缺省表示不改动 */
  note?: string | null
}

export interface MutationContext {
  actor: Member
  now: string
  newId: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function assertValidDate(date: DateKey): void {
  if (
    !DATE_RE.test(date) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) {
    throw new DomainError('invalid_date', `不是有效日期:${date}`)
  }
}

function monthOf(date: DateKey): MonthKey {
  return date.slice(0, 7)
}

function assertActive(member: Member): void {
  if (member.disabled) throw new DomainError('member_disabled', `成员已停用:${member.displayName}`)
}

/**
 * 金额上限(分):10^13 = 1000 亿元。公式编辑器允许 16 位数字,换算成分可达 ~1e18,
 * 超过 Number.MAX_SAFE_INTEGER 后继续累加/求值不再可靠,故写入前必须拦下。
 */
export const MAX_AMOUNT_CENTS = 10_000_000_000_000

/** 合法金额:正的安全整数分且不超过 MAX_AMOUNT_CENTS(领域校验与编辑器保存谓词共用) */
export function isValidAmountCents(amountCents: number): boolean {
  return Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= MAX_AMOUNT_CENTS
}

function assertValidAmount(amountCents: number): void {
  if (!isValidAmountCents(amountCents)) {
    throw new DomainError(
      'invalid_amount',
      `金额必须为正整数分且不超过 ${MAX_AMOUNT_CENTS}:${amountCents}`,
    )
  }
}

function findExpense(ledger: LedgerData, id: ExpenseId): { month: MonthKey; expense: Expense } {
  for (const [month, data] of Object.entries(ledger.months)) {
    const expense = data.expenses.find((e) => e.id === id)
    if (expense) return { month, expense }
  }
  throw new DomainError('unknown_expense', `支出不存在:${id}`)
}

/**
 * 全家透明 + 自我编辑:管理员、经手人、记录者可改删一笔支出。
 * 代记场景下,记录者与被代记的成员都拥有编辑权。
 */
export function canEditExpense(actor: Member, expense: Expense): boolean {
  return actor.role === 'admin' || actor.id === expense.memberId || actor.id === expense.recordedBy
}

function assertCanEdit(actor: Member, expense: Expense): void {
  if (!canEditExpense(actor, expense)) {
    throw new DomainError('forbidden', '只能修改/删除自己记的支出')
  }
}

function ensureMonth(ledger: LedgerData, month: MonthKey): void {
  ledger.months[month] ??= { expenses: [] }
}

function monthData(ledger: LedgerData, month: MonthKey): { expenses: Expense[] } {
  const data = ledger.months[month]
  if (!data) throw new DomainError('unknown_month', `月份文件不存在:${month}`)
  return data
}

function setMonthExpenses(ledger: LedgerData, month: MonthKey, remaining: Expense[]): void {
  if (remaining.length === 0) delete ledger.months[month]
  else ledger.months[month] = { expenses: remaining }
}

function validateForWrite(
  ledger: LedgerData,
  input: { amountCents: number; date: DateKey; categoryId: string; memberId: string },
): void {
  assertValidAmount(input.amountCents)
  assertValidDate(input.date)
  const category = findCategory(ledger, input.categoryId)
  if (!category.parentId) throw new DomainError('category_not_leaf', '支出必须归属子分类')
  assertActive(findMember(ledger, input.memberId))
}

function tagsForWrite(input: {
  tagIds?: string[]
  tagNames?: string[]
}): Pick<Expense, 'tagIds' | 'tagNames'> {
  if (input.tagIds !== undefined) return { tagIds: [...input.tagIds] }
  if (input.tagNames !== undefined) return { tagIds: [], tagNames: [...input.tagNames] }
  return { tagIds: [] }
}

/** 写入的 tagIds 必须指向账本中已有的标签实体(unknown_tag);废弃 tagNames 路径由迁移引擎负责补建 */
function assertKnownTagIds(ledger: LedgerData, tagIds: readonly string[]): void {
  for (const id of tagIds) findTag(ledger, id)
}

export function addExpense(
  ledger: LedgerData,
  input: ExpenseInput,
  ctx: MutationContext,
): LedgerData {
  assertActive(ctx.actor)
  const memberId = input.memberId ?? ctx.actor.id
  validateForWrite(ledger, { ...input, memberId })
  if (input.tagIds !== undefined) assertKnownTagIds(ledger, input.tagIds)

  const expense: Expense = {
    id: ctx.newId,
    amountCents: input.amountCents,
    date: input.date,
    categoryId: input.categoryId,
    ...tagsForWrite(input),
    memberId,
    recordedBy: ctx.actor.id,
    note: input.note,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }
  const month = monthOf(input.date)
  ensureMonth(ledger, month)
  monthData(ledger, month).expenses.push(expense)
  return ledger
}

export function updateExpense(
  ledger: LedgerData,
  id: ExpenseId,
  patch: ExpensePatch,
  ctx: MutationContext,
): LedgerData {
  assertActive(ctx.actor)
  const { month, expense } = findExpense(ledger, id)
  assertCanEdit(ctx.actor, expense)
  if (patch.tagIds !== undefined) assertKnownTagIds(ledger, patch.tagIds)

  const next: Expense = { ...expense }
  if (patch.amountCents !== undefined) next.amountCents = patch.amountCents
  if (patch.date !== undefined) next.date = patch.date
  if (patch.categoryId !== undefined) next.categoryId = patch.categoryId
  if (patch.tagIds !== undefined) {
    next.tagIds = [...patch.tagIds]
    // 新模型写入即视为完成转换,丢弃废弃字段,避免迁移时把已取消的旧标签带回
    delete next.tagNames
  } else if (patch.tagNames !== undefined) {
    next.tagNames = [...patch.tagNames]
    next.tagIds = []
  }
  if (patch.memberId !== undefined) next.memberId = patch.memberId
  if (patch.note !== undefined) next.note = patch.note === null ? undefined : patch.note
  validateForWrite(ledger, next)

  const list = monthData(ledger, month).expenses
  const idx = list.findIndex((e) => e.id === id)
  list[idx] = { ...next, updatedAt: ctx.now }

  const newMonth = monthOf(next.date)
  if (newMonth !== month) {
    setMonthExpenses(
      ledger,
      month,
      list.filter((e) => e.id !== id),
    )
    ensureMonth(ledger, newMonth)
    monthData(ledger, newMonth).expenses.push({ ...next, updatedAt: ctx.now })
  }
  return ledger
}

export function deleteExpense(ledger: LedgerData, id: ExpenseId, ctx: MutationContext): LedgerData {
  assertActive(ctx.actor)
  const { month, expense } = findExpense(ledger, id)
  assertCanEdit(ctx.actor, expense)

  setMonthExpenses(
    ledger,
    month,
    monthData(ledger, month).expenses.filter((e) => e.id !== id),
  )
  return ledger
}
