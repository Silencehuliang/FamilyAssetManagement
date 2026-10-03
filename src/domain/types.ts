export type MemberId = string
export type CategoryId = string
export type ExpenseId = string
export type RecurringId = string
export type TagId = string
export type TagGroupId = string

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
  /** 标签实体 id 列表(ADR-0006);新写入一律使用 tagIds */
  tagIds: TagId[]
  /**
   * @deprecated v1 的自由标签文本,仅用于兼容读取一个版本,由迁移引擎
   * (src/domain/tag-migration.ts)改写为 tagIds 后移除;新写入不得再依赖。
   */
  tagNames?: string[]
  /** 经手人 */
  memberId: MemberId
  /** 记录者(代记时与经手人不同) */
  recordedBy: MemberId
  note?: string
  createdAt: string
  updatedAt: string
}

/** 标签实体:名称可改,id 由名字确定性派生且终身不变 */
export interface Tag {
  id: TagId
  name: string
  updatedAt: string
}

/** 标签组颜色词汇(与分类颜色共用,ADR-0006) */
export type TagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray'

/** 标签组:一组语义相关的标签,带颜色与单选/必选规则;标签可不属于任何组 */
export interface TagGroup {
  id: TagGroupId
  name: string
  color: TagColor
  tagIds: TagId[]
  /** 组内至多选中一个 */
  singleSelect?: boolean
  /** 每笔支出都应从中选中一个;组内无可用标签时规则自动失效 */
  required?: boolean
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
  /** 补记支出携带的标签实体 id;旧规则可缺省 */
  tagIds?: TagId[]
  /** @deprecated v1 自由标签文本;由补记生成的支出经迁移引擎转换后移除 */
  tagNames: string[]
  /** 经手人(补记的支出归属该成员) */
  memberId: MemberId
  note?: string
  frequency: Frequency
  startDate: DateKey
  endDate?: DateKey
  enabled: boolean
  /** 规则创建者(成员可维护自己的规则;旧数据缺省时以 memberId 兜底) */
  createdBy?: MemberId
  /**
   * 补记游标:已补记到哪一天(含)。只生成该日之后的期次,
   * 因此删除某笔已补记支出不会被下一轮补记复活。
   */
  generatedThrough?: DateKey
  createdAt: string
  updatedAt: string
}

export interface LedgerMeta {
  members: Member[]
  categories: Category[]
  /** 标签实体(ADR-0006),id 由名字派生;全员可写 */
  tags: Tag[]
  /** 标签组(ADR-0006),管理员维护;成员端只拉 */
  tagGroups: TagGroup[]
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
  return {
    meta: { members: [], categories: [], tags: [], tagGroups: [], budgets: {}, recurring: [] },
    months: {},
  }
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
