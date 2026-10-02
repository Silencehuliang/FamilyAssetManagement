import type {
  Budget,
  Category,
  Expense,
  LedgerData,
  Member,
  MonthKey,
  RecurringExpense,
} from '../domain'
import { createEmptyLedger } from '../domain'

/**
 * 账本内存形态与仓库文件的映射(ADR-0005)。
 *
 * 文件清单:
 * - `ledger/months/<YYYY-MM>.json`:`{"expenses": [...]}`,按自然月一个文件;空月份不落文件
 * - `ledger/meta/members.json`:`{"members": [...]}`(成员含凭据字段,原样透传,不做裁剪)
 * - `ledger/meta/categories.json`:`{"categories": [...]}`
 * - `ledger/meta/budgets.json`:`{"budgets": {"<YYYY-MM>": {...}}}`
 * - `ledger/meta/recurring.json`:`{"recurring": [...]}`
 *
 * JSON 一律 2 空格缩进、结尾换行;budgets 的月份键按字典序输出,保证内容确定、diff 友好。
 */

export const MEMBERS_FILE = 'ledger/meta/members.json'
export const CATEGORIES_FILE = 'ledger/meta/categories.json'
export const BUDGETS_FILE = 'ledger/meta/budgets.json'
export const RECURRING_FILE = 'ledger/meta/recurring.json'

const MONTH_FILE_RE = /^ledger\/months\/(\d{4}-\d{2})\.json$/

/** 月份键 → 月份文件路径 */
export function monthFilePath(month: MonthKey): string {
  return `ledger/months/${month}.json`
}

/** 从文件路径解析月份键;不是月份文件路径时返回 undefined */
export function parseMonthFilePath(path: string): MonthKey | undefined {
  return MONTH_FILE_RE.exec(path)?.[1]
}

/** 是否为同步关心的账本文件(仓库里的 README 等其他文件不参与同步) */
export function isLedgerFilePath(path: string): boolean {
  return (
    MONTH_FILE_RE.test(path) ||
    path === MEMBERS_FILE ||
    path === CATEGORIES_FILE ||
    path === BUDGETS_FILE ||
    path === RECURRING_FILE
  )
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function withSortedMonthKeys(budgets: Record<MonthKey, Budget>): Record<MonthKey, Budget> {
  const sorted: Record<MonthKey, Budget> = {}
  for (const month of Object.keys(budgets).sort()) {
    const budget = budgets[month]
    if (budget) sorted[month] = budget
  }
  return sorted
}

/**
 * 账本 → 文件。空月份不产生文件;四个 meta 文件恒在(空集合也写出)。
 * 与 filesToLedger 互逆(对不含空月份条目的账本严格成立)。
 */
export function ledgerToFiles(ledger: LedgerData): Record<string, string> {
  const files: Record<string, string> = {}
  for (const month of Object.keys(ledger.months).sort()) {
    const data = ledger.months[month]
    if (!data || data.expenses.length === 0) continue
    files[monthFilePath(month)] = serialize({ expenses: data.expenses })
  }
  files[MEMBERS_FILE] = serialize({ members: ledger.meta.members })
  files[CATEGORIES_FILE] = serialize({ categories: ledger.meta.categories })
  files[BUDGETS_FILE] = serialize({ budgets: withSortedMonthKeys(ledger.meta.budgets) })
  files[RECURRING_FILE] = serialize({ recurring: ledger.meta.recurring })
  return files
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function parseJsonFile(path: string, content: string): unknown {
  try {
    return JSON.parse(content)
  } catch (cause) {
    throw new Error(`账本文件不是有效 JSON:${path}`, { cause })
  }
}

function arrayField<T>(path: string, content: string, field: string): T[] {
  const parsed = parseJsonFile(path, content)
  return isObject(parsed) ? asArray<T>(parsed[field]) : []
}

/**
 * 文件 → 账本(ledgerToFiles 的逆映射),宽容反序列化:
 * - 缺失的 meta 文件视为空集合;缺失的月份文件视为该月无支出
 * - `{"expenses": []}` 的月份文件不建月份条目(与「空月份不落文件」对称)
 * - 无效 JSON 抛错(宁可失败,不静默丢数据);形状不对的字段按空处理
 * - 不认识的路径忽略;月份路径必须是 `YYYY-MM` 命名,其余忽略
 */
export function filesToLedger(files: Record<string, string>): LedgerData {
  const ledger = createEmptyLedger()
  for (const [path, content] of Object.entries(files)) {
    const month = parseMonthFilePath(path)
    if (!month) continue
    const parsed = parseJsonFile(path, content)
    const expenses = isObject(parsed) ? asArray<Expense>(parsed.expenses) : []
    if (expenses.length > 0) ledger.months[month] = { expenses }
  }

  const members = files[MEMBERS_FILE]
  if (members !== undefined) {
    ledger.meta.members = arrayField<Member>(MEMBERS_FILE, members, 'members')
  }

  const categories = files[CATEGORIES_FILE]
  if (categories !== undefined) {
    ledger.meta.categories = arrayField<Category>(CATEGORIES_FILE, categories, 'categories')
  }

  const recurring = files[RECURRING_FILE]
  if (recurring !== undefined) {
    ledger.meta.recurring = arrayField<RecurringExpense>(RECURRING_FILE, recurring, 'recurring')
  }

  const budgets = files[BUDGETS_FILE]
  if (budgets !== undefined) {
    const parsed = parseJsonFile(BUDGETS_FILE, budgets)
    const raw = isObject(parsed) ? parsed.budgets : undefined
    const map: Record<MonthKey, Budget> = {}
    if (isObject(raw)) {
      for (const [month, value] of Object.entries(raw)) {
        if (isObject(value)) map[month] = value as unknown as Budget
      }
    }
    ledger.meta.budgets = map
  }
  return ledger
}
