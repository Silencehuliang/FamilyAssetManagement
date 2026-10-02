/**
 * 预算领域(T11):按月设置总预算与子分类预算(管理员专属),纯函数原地修改账本。
 * 预算不阻止超支,只给出余量与超支判定;budgetProgress 供预算页/报告展示。
 */
import type { MonthAggregate } from './aggregate'
import { findCategory } from './lookup'
import type { Budget, CategoryId, LedgerData, Member, MonthKey } from './types'
import { DomainError } from './types'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function requireAdmin(actor: Member): void {
  if (actor.role !== 'admin') throw new DomainError('forbidden', '仅管理员可管理预算')
}

function assertMonth(month: MonthKey): void {
  if (!MONTH_RE.test(month)) {
    throw new DomainError('invalid_month', `月份格式应为 YYYY-MM:${month}`)
  }
}

function assertBudgetAmount(cents: number | null): void {
  if (cents !== null && (!Number.isInteger(cents) || cents <= 0)) {
    throw new DomainError('invalid_amount', `预算必须为正整数分:${cents}`)
  }
}

function ensureBudget(ledger: LedgerData, month: MonthKey): Budget {
  ledger.meta.budgets[month] ??= { categoryCents: {} }
  return ledger.meta.budgets[month]
}

/** 总/分类预算都被清除后删掉整月条目,保持 budgets.json 无空壳 */
function pruneBudget(ledger: LedgerData, month: MonthKey): void {
  const budget = ledger.meta.budgets[month]
  if (!budget) return
  if (budget.totalCents === undefined && Object.keys(budget.categoryCents).length === 0) {
    delete ledger.meta.budgets[month]
  }
}

/** 设置/修改月度总预算;cents=null 清除。仅管理员。 */
export function setTotalBudget(
  ledger: LedgerData,
  actor: Member,
  month: MonthKey,
  cents: number | null,
): LedgerData {
  requireAdmin(actor)
  assertMonth(month)
  assertBudgetAmount(cents)

  if (cents === null) {
    const budget = ledger.meta.budgets[month]
    if (budget) {
      delete budget.totalCents
      pruneBudget(ledger, month)
    }
    return ledger
  }
  ensureBudget(ledger, month).totalCents = cents
  return ledger
}

/** 设置/修改子分类月度预算;cents=null 清除。仅管理员;预算只能挂在子分类上。 */
export function setCategoryBudget(
  ledger: LedgerData,
  actor: Member,
  month: MonthKey,
  categoryId: CategoryId,
  cents: number | null,
): LedgerData {
  requireAdmin(actor)
  assertMonth(month)
  assertBudgetAmount(cents)
  const category = findCategory(ledger, categoryId)
  if (category.parentId === undefined) {
    throw new DomainError('category_not_leaf', '预算需设置在子分类上')
  }

  if (cents === null) {
    const budget = ledger.meta.budgets[month]
    if (budget) {
      delete budget.categoryCents[categoryId]
      pruneBudget(ledger, month)
    }
    return ledger
  }
  ensureBudget(ledger, month).categoryCents[categoryId] = cents
  return ledger
}

/** 清除整月预算(总预算 + 全部分类预算);仅管理员。 */
export function clearBudget(ledger: LedgerData, actor: Member, month: MonthKey): LedgerData {
  requireAdmin(actor)
  assertMonth(month)
  delete ledger.meta.budgets[month]
  return ledger
}

/** 控制器的预算补丁:未提供的字段不改动;null 表示清除。 */
export interface BudgetPatch {
  /** 总预算(整数分)或 null 清除 */
  totalCents?: number | null
  /** 分类预算目标;与 categoryCents 配对 */
  categoryId?: CategoryId
  categoryCents?: number | null
}

export interface CategoryBudgetProgress {
  categoryId: CategoryId
  budgetCents: number
  spentCents: number
  remainingCents: number
  overspent: boolean
}

export interface BudgetProgress {
  /** 是否设置了总预算;未设置时 totalCents 为 0,remainingCents 无参考意义 */
  hasTotalBudget: boolean
  totalCents: number
  spentCents: number
  remainingCents: number
  overspent: boolean
  byCategory: CategoryBudgetProgress[]
}

/**
 * 预算执行进度(纯函数):由月度聚合与预算计算余量与超支。
 * budget 缺省(未设预算)时 hasTotalBudget=false;无分类预算时 byCategory 为空。
 */
export function budgetProgress(
  aggregate: MonthAggregate,
  budget: Budget | undefined,
): BudgetProgress {
  const spentCents = aggregate.totalCents
  const totalCents = budget?.totalCents ?? 0
  const hasTotalBudget = budget?.totalCents !== undefined

  const byCategory = Object.entries(budget?.categoryCents ?? {})
    .map(([categoryId, budgetCents]) => {
      const spent = aggregate.byCategory.find((slice) => slice.id === categoryId)?.totalCents ?? 0
      return {
        categoryId,
        budgetCents,
        spentCents: spent,
        remainingCents: budgetCents - spent,
        overspent: spent > budgetCents,
      }
    })
    .sort(
      (a, b) =>
        b.budgetCents - a.budgetCents ||
        (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0),
    )

  return {
    hasTotalBudget,
    totalCents,
    spentCents,
    remainingCents: totalCents - spentCents,
    overspent: hasTotalBudget && spentCents > totalCents,
    byCategory,
  }
}

export interface MonthBudgetOutcome {
  month: MonthKey
  totalCents: number
  spentCents: number
  achieved: boolean
}

/** 某月总预算执行结果;未设总预算时返回 null。 */
export function budgetOutcome(ledger: LedgerData, month: MonthKey): MonthBudgetOutcome | null {
  const totalCents = ledger.meta.budgets[month]?.totalCents
  if (totalCents === undefined) return null
  let spentCents = 0
  for (const expense of ledger.months[month]?.expenses ?? []) spentCents += expense.amountCents
  return { month, totalCents, spentCents, achieved: spentCents <= totalCents }
}

/** 历史达成情况:设有总预算的月份,按月份倒序。 */
export function budgetHistory(ledger: LedgerData): MonthBudgetOutcome[] {
  const outcomes: MonthBudgetOutcome[] = []
  for (const month of Object.keys(ledger.meta.budgets).sort((a, b) => b.localeCompare(a))) {
    const outcome = budgetOutcome(ledger, month)
    if (outcome) outcomes.push(outcome)
  }
  return outcomes
}
