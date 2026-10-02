export type MemberId = string
export type CategoryId = string
export type ExpenseId = string
export type RecurringId = string

/** YYYY-MM,如 2026-10 */
export type MonthKey = string
/** YYYY-MM-DD,本地日期 */
export type DateKey = string

export type Role = 'admin' | 'member'

export interface Member {
  id: MemberId
  username: string
  displayName: string
  role: Role
  disabled: boolean
  createdAt: string
}

export interface Category {
  id: CategoryId
  name: string
  /** 子分类持有父分类 id;父分类无此字段 */
  parentId?: CategoryId
  sortOrder: number
}

export interface Expense {
  id: ExpenseId
  /** 金额,整数分,必须为正 */
  amountCents: number
  date: DateKey
  categoryId: CategoryId
  tagNames: string[]
  /** 经手人 */
  memberId: MemberId
  /** 记录者(代记时与经手人不同) */
  recordedBy: MemberId
  note?: string
  createdAt: string
  updatedAt: string
}

export interface Budget {
  totalCents?: number
  categoryCents: Record<CategoryId, number>
}

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface RecurringExpense {
  id: RecurringId
  amountCents: number
  categoryId: CategoryId
  tagNames: string[]
  memberId: MemberId
  note?: string
  frequency: Frequency
  startDate: DateKey
  endDate?: DateKey
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface LedgerMeta {
  members: Member[]
  categories: Category[]
  budgets: Record<MonthKey, Budget>
  recurring: RecurringExpense[]
}

export interface MonthData {
  expenses: Expense[]
}

/**
 * 账本的内存形态。与仓库文件的对应关系(见 docs/adr/0005):
 * months[m] ↔ ledger/months/<m>.json;meta.members ↔ ledger/meta/members.json;依此类推。
 * 领域操作原地修改传入的账本并返回它;记录级冲突以 updatedAt 后写胜出(ADR-0004)。
 */
export interface LedgerData {
  meta: LedgerMeta
  months: Record<MonthKey, MonthData>
}

export function createEmptyLedger(): LedgerData {
  return { meta: { members: [], categories: [], budgets: {}, recurring: [] }, months: {} }
}

/** 领域规则不满足时抛出;code 用于界面映射为可读文案 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'DomainError'
  }
}
