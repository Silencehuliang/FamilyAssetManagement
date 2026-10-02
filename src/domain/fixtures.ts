import { DEFAULT_CATEGORIES } from './defaults'
import type { Expense, LedgerData, Member } from './types'

export const ADMIN: Member = {
  id: 'm-admin',
  username: 'aming',
  displayName: '阿明',
  role: 'admin',
  disabled: false,
  createdAt: '2026-09-01T08:00:00.000Z',
}
export const XIAOHONG: Member = {
  id: 'm-xh',
  username: 'xiaohong',
  displayName: '小红',
  role: 'member',
  disabled: false,
  createdAt: '2026-09-01T08:00:00.000Z',
}
export const LAOSAN: Member = {
  id: 'm-ls',
  username: 'laosan',
  displayName: '老三',
  role: 'member',
  disabled: true,
  createdAt: '2026-09-01T08:00:00.000Z',
}
export const DALI: Member = {
  id: 'm-dl',
  username: 'dali',
  displayName: '大力',
  role: 'member',
  disabled: false,
  createdAt: '2026-09-01T08:00:00.000Z',
}

export function fixtureLedger(): LedgerData {
  return {
    meta: {
      members: [ADMIN, XIAOHONG, LAOSAN, DALI],
      categories: structuredClone(DEFAULT_CATEGORIES),
      budgets: {},
      recurring: [],
    },
    months: {},
  }
}

export const LUNCH_CATEGORY = 'cat-dining-2' // 午餐
export const DINNER_CATEGORY = 'cat-dining-3' // 晚餐

let idSeq = 0
export function nextId(prefix = 'e'): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

export const NOW = '2026-10-02T12:00:00.000Z'

/** 测试取数:断言该月该条支出存在,否则让测试显式失败 */
export function expenseAt(ledger: LedgerData, month: string, index: number): Expense {
  const expense = ledger.months[month]?.expenses[index]
  if (!expense) throw new Error(`fixture: ${month}[${index}] 不存在`)
  return expense
}
