import { describe, expect, it } from 'vitest'
import type { Expense, LedgerData } from '../domain'
import { createEmptyLedger } from '../domain'

/** 成员数据不属同步文件集(服务端专管):比较账本内容时忽略 members */
function sansMembers<L extends { meta: { members: unknown[] } }>(l: L): L {
  return { ...l, meta: { ...l.meta, members: [] } }
}

import {
  BUDGETS_FILE,
  CATEGORIES_FILE,
  filesToLedger,
  isLedgerFilePath,
  ledgerToFiles,
  monthFilePath,
  parseMonthFilePath,
  RECURRING_FILE,
  TAG_GROUPS_FILE,
  TAGS_FILE,
} from './files'

const MEMBER = {
  id: 'm-1',
  username: 'aming',
  displayName: '阿明',
  role: 'admin' as const,
  disabled: false,
  createdAt: '2026-09-01T08:00:00.000Z',
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e-1',
    amountCents: 2500,
    date: '2026-10-02',
    categoryId: 'cat-dining-2',
    tagIds: ['tag-wx'],
    memberId: 'm-1',
    recordedBy: 'm-1',
    createdAt: '2026-10-02T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
    ...overrides,
  }
}

function contentLedger(): LedgerData {
  return {
    meta: {
      members: [MEMBER],
      categories: [
        { id: 'c-1', name: '餐饮', sortOrder: 1 },
        { id: 'c-2', name: '午餐', parentId: 'c-1', sortOrder: 1 },
      ],
      tags: [{ id: 'tag-wx', name: '微信', updatedAt: '2026-10-01T00:00:00.000Z' }],
      tagGroups: [
        {
          id: 'grp-1',
          name: '支付方式',
          color: 'blue',
          tagIds: ['tag-wx'],
          singleSelect: true,
          required: true,
        },
      ],
      budgets: { '2026-10': { totalCents: 300000, categoryCents: { 'c-2': 100000 } } },
      recurring: [
        {
          id: 'r-1',
          amountCents: 3000,
          categoryId: 'c-2',
          tagNames: [],
          memberId: 'm-1',
          frequency: 'monthly',
          startDate: '2026-10-01',
          enabled: true,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
    months: {
      '2026-09': { expenses: [expense({ id: 'e-2', date: '2026-09-30' })] },
      '2026-10': { expenses: [expense()] },
    },
  }
}

describe('ledgerToFiles', () => {
  it('空账本恰好产生 5 个 meta 文件(members.json 不属同步范围),无月份文件,内容为空集合', () => {
    const files = ledgerToFiles(createEmptyLedger())
    expect(Object.keys(files).sort()).toEqual(
      [CATEGORIES_FILE, TAGS_FILE, TAG_GROUPS_FILE, BUDGETS_FILE, RECURRING_FILE].sort(),
    )
    expect(files['ledger/meta/members.json']).toBeUndefined()
    expect(files[CATEGORIES_FILE]).toBe('{\n  "categories": []\n}\n')
    expect(files[TAGS_FILE]).toBe('{\n  "tags": []\n}\n')
    expect(files[TAG_GROUPS_FILE]).toBe('{\n  "groups": []\n}\n')
    expect(files[BUDGETS_FILE]).toBe('{\n  "budgets": {}\n}\n')
    expect(files[RECURRING_FILE]).toBe('{\n  "recurring": []\n}\n')
  })

  it('月份映射到 ledger/months/<YYYY-MM>.json,2 空格缩进、结尾换行', () => {
    const files = ledgerToFiles(contentLedger())
    expect(Object.keys(files).sort()).toEqual(
      [
        monthFilePath('2026-09'),
        monthFilePath('2026-10'),
        CATEGORIES_FILE,
        TAGS_FILE,
        TAG_GROUPS_FILE,
        BUDGETS_FILE,
        RECURRING_FILE,
      ].sort(),
    )
    const monthContent = files[monthFilePath('2026-10')]
    expect(monthContent).toBeDefined()
    expect(monthContent).toBe(`${JSON.stringify({ expenses: [expense()] }, null, 2)}\n`)
    expect(monthContent?.endsWith('\n')).toBe(true)
  })

  it('空月份不产生文件', () => {
    const ledger = createEmptyLedger()
    ledger.months['2026-11'] = { expenses: [] }
    const files = ledgerToFiles(ledger)
    expect(files[monthFilePath('2026-11')]).toBeUndefined()
    expect(Object.keys(files)).toHaveLength(5)
  })
})

describe('filesToLedger', () => {
  it('与 ledgerToFiles 互逆(往返性质,忽略不参与同步的 members)', () => {
    expect(sansMembers(filesToLedger(ledgerToFiles(contentLedger())))).toEqual(
      sansMembers(contentLedger()),
    )
    expect(filesToLedger(ledgerToFiles(createEmptyLedger()))).toEqual(createEmptyLedger())
  })

  it('宽容:缺失 meta 文件视为空集合,不认识的路径忽略', () => {
    expect(filesToLedger({})).toEqual(createEmptyLedger())
    expect(filesToLedger({ 'README.md': '# 说明' })).toEqual(createEmptyLedger())
  })

  it('宽容:tags/tagGroups 形状不对按空集合;旧记录 tagNames 原样保留供迁移', () => {
    const legacy = {
      id: 'e-legacy',
      amountCents: 900,
      date: '2026-10-01',
      categoryId: 'cat-dining-2',
      tagNames: ['微信'],
      memberId: 'm-1',
      recordedBy: 'm-1',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }
    const ledger = filesToLedger({
      [TAGS_FILE]: '{"tags": "not-an-array"}\n',
      [TAG_GROUPS_FILE]: '[]\n',
      [monthFilePath('2026-10')]: JSON.stringify({ expenses: [legacy] }),
    })
    expect(ledger.meta.tags).toEqual([])
    expect(ledger.meta.tagGroups).toEqual([])
    expect(ledger.months['2026-10']?.expenses[0]?.tagNames).toEqual(['微信'])
  })

  it('宽容:months 目录下非 YYYY-MM 命名忽略,空支出月份文件不建月份条目', () => {
    const ledger = filesToLedger({
      'ledger/months/notes.json': '{"expenses": []}\n',
      [monthFilePath('2026-10')]: '{\n  "expenses": []\n}\n',
    })
    expect(ledger.months).toEqual({})
  })

  it('无效 JSON 抛错并带路径信息', () => {
    expect(() => filesToLedger({ [CATEGORIES_FILE]: '不是 JSON' })).toThrowError(CATEGORIES_FILE)
  })
})

describe('路径工具', () => {
  it('parseMonthFilePath 与 isLedgerFilePath', () => {
    expect(parseMonthFilePath('ledger/months/2026-10.json')).toBe('2026-10')
    expect(parseMonthFilePath('ledger/months/notes.json')).toBeUndefined()
    expect(parseMonthFilePath('ledger/meta/members.json')).toBeUndefined()
    expect(isLedgerFilePath(monthFilePath('2026-10'))).toBe(true)
    expect(isLedgerFilePath(RECURRING_FILE)).toBe(true)
    expect(isLedgerFilePath(TAGS_FILE)).toBe(true)
    expect(isLedgerFilePath(TAG_GROUPS_FILE)).toBe(true)
    expect(isLedgerFilePath('ledger/months/notes.json')).toBe(false)
    expect(isLedgerFilePath('README.md')).toBe(false)
  })
})
