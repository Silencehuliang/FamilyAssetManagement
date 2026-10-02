/**
 * 周期支出领域(T12):规则 CRUD 与到期补记。
 *
 * - 频率支持每日/每周/每月/每年;每月与每年遇短月/非闰年时收敛到当月最后一天
 *   (如 1 月 31 日规则 → 2 月 28/29 日;2 月 29 日年度规则 → 平年 2 月 28 日)。
 * - 补记(客户端打开应用/同步后调用)为所有启用规则生成截至今天的支出,
 *   支出 id 固定为 `rec-<ruleId>-<date>`:重复执行幂等,多设备生成同一批记录,
 *   经 LWW 合并自然收敛。
 * - 修改规则只影响之后的期次:已生成的旧 id 命中「已存在」而跳过,历史不动。
 * - 权限同支出:创建者可维护,经手人与管理员亦可(全家透明 + 自我编辑)。
 */
import type { MutationContext } from './expenses'
import { findCategory, findMember } from './lookup'
import type {
  CategoryId,
  DateKey,
  ExpenseId,
  Frequency,
  LedgerData,
  Member,
  MemberId,
  RecurringExpense,
  RecurringId,
} from './types'
import { DomainError } from './types'

export const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly', 'yearly']

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
}

export const RECURRING_DEFAULT_NOTE = '周期支出'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

function assertValidDate(date: DateKey): void {
  if (
    !DATE_RE.test(date) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new DomainError('invalid_date', `不是有效日期:${date}`)
  }
}

function compareDate(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 年月日 → DateKey(day 会被收敛到当月最后一天,处理短月/闰年) */
function clampedDate(year: number, month: number, day: number): DateKey {
  const lastDay = daysInMonth(year, month)
  const safeDay = Math.min(day, lastDay)
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(safeDay)}`
}

function parseDateKey(date: DateKey): { year: number; month: number; day: number } {
  const [year = '1970', month = '01', day = '01'] = date.split('-')
  return { year: Number(year), month: Number(month), day: Number(day) }
}

function addDays(date: DateKey, days: number): DateKey {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function daysBetween(from: DateKey, to: DateKey): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

/** 生成 [from, to] 内的所有到期日(升序);startDate/endDate 由规则界定 */
function* occurrences(rule: RecurringExpense, from: DateKey, to: DateKey): Generator<DateKey> {
  const start = rule.startDate
  if (compareDate(start, to) > 0) return
  const begin = compareDate(start, from) > 0 ? start : from
  const end = rule.endDate !== undefined && compareDate(rule.endDate, to) < 0 ? rule.endDate : to
  if (compareDate(begin, end) > 0) return

  const startParts = parseDateKey(start)
  switch (rule.frequency) {
    case 'daily': {
      for (let date = begin; compareDate(date, end) <= 0; date = addDays(date, 1)) {
        yield date
      }
      return
    }
    case 'weekly': {
      const weeks = Math.ceil(daysBetween(start, begin) / 7)
      for (
        let date = addDays(start, weeks * 7);
        compareDate(date, end) <= 0;
        date = addDays(date, 7)
      ) {
        if (compareDate(date, begin) >= 0) yield date
      }
      return
    }
    case 'monthly': {
      const beginParts = parseDateKey(begin)
      let cursor = { year: beginParts.year, month: beginParts.month }
      for (;;) {
        const date = clampedDate(cursor.year, cursor.month, startParts.day)
        if (compareDate(date, end) > 0) return
        if (compareDate(date, begin) >= 0 && compareDate(date, start) >= 0) yield date
        cursor = nextMonth(cursor.year, cursor.month)
      }
    }
    case 'yearly': {
      const beginParts = parseDateKey(begin)
      let year = beginParts.year
      for (;;) {
        const date = clampedDate(year, startParts.month, startParts.day)
        if (compareDate(date, end) > 0) return
        if (compareDate(date, begin) >= 0 && compareDate(date, start) >= 0) yield date
        year += 1
      }
    }
  }
}

/** 规则在 [fromDate, toDate] 内的到期日(升序;不含停用判断) */
export function dueDates(rule: RecurringExpense, fromDate: DateKey, toDate: DateKey): DateKey[] {
  if (compareDate(fromDate, toDate) > 0) return []
  return [...occurrences(rule, fromDate, toDate)]
}

/** 下一次到期日;停用、已结束或规则无未来期次时返回 undefined */
export function nextDueDate(rule: RecurringExpense, from: DateKey): DateKey | undefined {
  if (!rule.enabled) return undefined
  // 4 年窗口覆盖闰日规则(2 月 29 日)的最坏间隔
  for (const date of occurrences(rule, from, addDays(from, 1462))) {
    return date
  }
  return undefined
}

export interface GenerateResult {
  generated: number
  expenseIds: ExpenseId[]
}

/**
 * 补记截至 today 的全部到期支出:以规则上的 generatedThrough 游标推进,
 * 只生成游标之后(含今日)的期次 —— 因此删除某笔已补记支出不会被下一轮复活。
 * 同 id 已存在时跳过(多端并发的幂等保险);规则指向的分类/成员缺失或
 * 成员停用时跳过该规则且不推进游标(条件恢复后会补上)。
 */
export function generateDueExpenses(
  ledger: LedgerData,
  today: DateKey,
  now: string,
): GenerateResult {
  const existing = new Set<ExpenseId>()
  for (const month of Object.values(ledger.months)) {
    for (const expense of month.expenses) existing.add(expense.id)
  }
  const categoryById = new Map(ledger.meta.categories.map((category) => [category.id, category]))
  const memberById = new Map(ledger.meta.members.map((member) => [member.id, member]))

  const expenseIds: ExpenseId[] = []
  for (const rule of ledger.meta.recurring) {
    if (!rule.enabled) continue
    const category = categoryById.get(rule.categoryId)
    if (!category || category.parentId === undefined) continue
    const member = memberById.get(rule.memberId)
    if (!member || member.disabled) continue

    const from = rule.generatedThrough ? addDays(rule.generatedThrough, 1) : rule.startDate
    if (from > today) continue
    const dates = dueDates(rule, from, today)
    if (dates.length === 0) continue

    for (const date of dates) {
      const id = `rec-${rule.id}-${date}`
      if (existing.has(id)) continue
      existing.add(id)
      const month = date.slice(0, 7)
      ledger.months[month] ??= { expenses: [] }
      ledger.months[month].expenses.push({
        id,
        amountCents: rule.amountCents,
        date,
        categoryId: rule.categoryId,
        tagNames: [...rule.tagNames],
        memberId: rule.memberId,
        recordedBy: rule.createdBy ?? rule.memberId,
        note: rule.note ?? RECURRING_DEFAULT_NOTE,
        createdAt: now,
        updatedAt: now,
      })
      expenseIds.push(id)
    }
    // 游标推进到本轮覆盖的最后到期日(更新 updatedAt 以便经 LWW 同步到其他设备)
    rule.generatedThrough = dates[dates.length - 1]
    rule.updatedAt = now
  }
  return { generated: expenseIds.length, expenseIds }
}

export interface RecurringInput {
  amountCents: number
  categoryId: CategoryId
  tagNames?: string[]
  /** 经手人,缺省为创建者本人 */
  memberId?: MemberId
  note?: string
  frequency: Frequency
  startDate: DateKey
  endDate?: DateKey
  enabled?: boolean
}

export interface RecurringPatch {
  amountCents?: number
  categoryId?: CategoryId
  tagNames?: string[]
  memberId?: MemberId
  /** 传 null 清除备注;缺省表示不改动 */
  note?: string | null
  frequency?: Frequency
  startDate?: DateKey
  /** 传 null 清除结束日期 */
  endDate?: DateKey | null
  enabled?: boolean
}

/** 规则维护权:创建者、经手人与管理员;旧数据无 createdBy 时以经手人兜底 */
export function canEditRecurring(actor: Member, rule: RecurringExpense): boolean {
  return actor.role === 'admin' || actor.id === rule.createdBy || actor.id === rule.memberId
}

function assertActive(member: Member): void {
  if (member.disabled) throw new DomainError('member_disabled', `成员已停用:${member.displayName}`)
}

function assertFrequency(frequency: Frequency): void {
  if (!FREQUENCIES.includes(frequency)) {
    throw new DomainError('invalid_frequency', `不支持的频率:${frequency}`)
  }
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new DomainError('invalid_amount', `金额必须为正整数分:${amountCents}`)
  }
}

function validateRule(
  ledger: LedgerData,
  rule: {
    amountCents: number
    categoryId: CategoryId
    memberId: MemberId
    frequency: Frequency
    startDate: DateKey
    endDate?: DateKey
  },
): void {
  assertValidAmount(rule.amountCents)
  assertFrequency(rule.frequency)
  assertValidDate(rule.startDate)
  if (rule.endDate !== undefined) {
    assertValidDate(rule.endDate)
    if (compareDate(rule.endDate, rule.startDate) < 0) {
      throw new DomainError('invalid_range', '结束日期不能早于起始日期')
    }
  }
  const category = findCategory(ledger, rule.categoryId)
  if (category.parentId === undefined) {
    throw new DomainError('category_not_leaf', '周期支出必须归属子分类')
  }
  assertActive(findMember(ledger, rule.memberId))
}

function findRecurring(ledger: LedgerData, id: RecurringId): RecurringExpense {
  const rule = ledger.meta.recurring.find((item) => item.id === id)
  if (!rule) throw new DomainError('unknown_recurring', `周期支出规则不存在:${id}`)
  return rule
}

function assertCanEdit(actor: Member, rule: RecurringExpense): void {
  if (!canEditRecurring(actor, rule)) {
    throw new DomainError('forbidden', '只能修改/删除自己的周期支出规则')
  }
}

export function addRecurring(
  ledger: LedgerData,
  input: RecurringInput,
  ctx: MutationContext,
): LedgerData {
  assertActive(ctx.actor)
  const memberId = input.memberId ?? ctx.actor.id
  validateRule(ledger, { ...input, memberId })

  ledger.meta.recurring.push({
    id: ctx.newId,
    amountCents: input.amountCents,
    categoryId: input.categoryId,
    tagNames: input.tagNames ? [...input.tagNames] : [],
    memberId,
    note: input.note,
    frequency: input.frequency,
    startDate: input.startDate,
    endDate: input.endDate,
    enabled: input.enabled ?? true,
    createdBy: ctx.actor.id,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  })
  return ledger
}

export function updateRecurring(
  ledger: LedgerData,
  id: RecurringId,
  patch: RecurringPatch,
  ctx: MutationContext,
): LedgerData {
  assertActive(ctx.actor)
  const rule = findRecurring(ledger, id)
  assertCanEdit(ctx.actor, rule)

  const next: RecurringExpense = { ...rule }
  if (patch.amountCents !== undefined) next.amountCents = patch.amountCents
  if (patch.categoryId !== undefined) next.categoryId = patch.categoryId
  if (patch.tagNames !== undefined) next.tagNames = [...patch.tagNames]
  if (patch.memberId !== undefined) next.memberId = patch.memberId
  if (patch.note !== undefined) next.note = patch.note === null ? undefined : patch.note
  if (patch.frequency !== undefined) next.frequency = patch.frequency
  if (patch.startDate !== undefined) next.startDate = patch.startDate
  if (patch.endDate !== undefined) {
    next.endDate = patch.endDate === null ? undefined : patch.endDate
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  validateRule(ledger, next)

  next.updatedAt = ctx.now
  ledger.meta.recurring = ledger.meta.recurring.map((item) => (item.id === id ? next : item))
  return ledger
}

export function removeRecurring(
  ledger: LedgerData,
  id: RecurringId,
  ctx: MutationContext,
): LedgerData {
  assertActive(ctx.actor)
  const rule = findRecurring(ledger, id)
  assertCanEdit(ctx.actor, rule)
  ledger.meta.recurring = ledger.meta.recurring.filter((item) => item.id !== id)
  return ledger
}
