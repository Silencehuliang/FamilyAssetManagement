import type { Category, DateKey, Expense, ExpenseId, LedgerData, Member } from './types'
import { DomainError } from './types'

export interface ExpenseInput {
  amountCents: number
  date: DateKey
  categoryId: Category['id']
  tagNames?: string[]
  /** 经手人,缺省为记录者本人(代记时指定他人) */
  memberId?: Member['id']
  note?: string
}

export interface ExpensePatch {
  amountCents?: number
  date?: DateKey
  categoryId?: Category['id']
  tagNames?: string[]
  note?: string
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

function monthOf(date: DateKey): string {
  return date.slice(0, 7)
}

function findMember(ledger: LedgerData, id: string): Member {
  const member = ledger.meta.members.find((m) => m.id === id)
  if (!member) throw new DomainError('unknown_member', `成员不存在:${id}`)
  return member
}

function assertActive(member: Member): void {
  if (member.disabled) throw new DomainError('member_disabled', `成员已停用:${member.displayName}`)
}

function findCategory(ledger: LedgerData, id: string): Category {
  const category = ledger.meta.categories.find((c) => c.id === id)
  if (!category) throw new DomainError('unknown_category', `分类不存在:${id}`)
  return category
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new DomainError('invalid_amount', `金额必须为正整数分:${amountCents}`)
  }
}

function findExpense(ledger: LedgerData, id: ExpenseId): { month: string; expense: Expense } {
  for (const [month, data] of Object.entries(ledger.months)) {
    const expense = data.expenses.find((e) => e.id === id)
    if (expense) return { month, expense }
  }
  throw new DomainError('unknown_expense', `支出不存在:${id}`)
}

/** 全家透明 + 自我编辑:成员可改删自己记的,管理员可改删任何记录 */
export function canEditExpense(actor: Member, expense: Expense): boolean {
  return actor.role === 'admin' || actor.id === expense.memberId
}

function assertCanEdit(actor: Member, expense: Expense): void {
  if (!canEditExpense(actor, expense)) {
    throw new DomainError('forbidden', '只能修改/删除自己记的支出')
  }
}

function ensureMonth(ledger: LedgerData, month: string): void {
  ledger.months[month] ??= { expenses: [] }
}

function monthData(ledger: LedgerData, month: string): { expenses: Expense[] } {
  const data = ledger.months[month]
  if (!data) throw new DomainError('unknown_month', `月份文件不存在:${month}`)
  return data
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

export function addExpense(
  ledger: LedgerData,
  input: ExpenseInput,
  ctx: MutationContext,
): LedgerData {
  assertActive(ctx.actor)
  const memberId = input.memberId ?? ctx.actor.id
  validateForWrite(ledger, { ...input, memberId })

  const expense: Expense = {
    id: ctx.newId,
    amountCents: input.amountCents,
    date: input.date,
    categoryId: input.categoryId,
    tagNames: input.tagNames ? [...input.tagNames] : [],
    memberId,
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

  const next: Expense = { ...expense }
  if (patch.amountCents !== undefined) next.amountCents = patch.amountCents
  if (patch.date !== undefined) next.date = patch.date
  if (patch.categoryId !== undefined) next.categoryId = patch.categoryId
  if (patch.tagNames !== undefined) next.tagNames = [...patch.tagNames]
  if (patch.note !== undefined) next.note = patch.note
  validateForWrite(ledger, next)

  const list = monthData(ledger, month).expenses
  const idx = list.findIndex((e) => e.id === id)
  list[idx] = { ...next, updatedAt: ctx.now }

  const newMonth = monthOf(next.date)
  if (newMonth !== month) {
    const remaining = list.filter((e) => e.id !== id)
    if (remaining.length === 0) delete ledger.months[month]
    else ledger.months[month] = { expenses: remaining }
    ensureMonth(ledger, newMonth)
    monthData(ledger, newMonth).expenses.push({ ...next, updatedAt: ctx.now })
  }
  return ledger
}

export function deleteExpense(ledger: LedgerData, id: ExpenseId, ctx: MutationContext): LedgerData {
  assertActive(ctx.actor)
  const { month, expense } = findExpense(ledger, id)
  assertCanEdit(ctx.actor, expense)

  const remaining = monthData(ledger, month).expenses.filter((e) => e.id !== id)
  if (remaining.length === 0) delete ledger.months[month]
  else ledger.months[month] = { expenses: remaining }
  return ledger
}
