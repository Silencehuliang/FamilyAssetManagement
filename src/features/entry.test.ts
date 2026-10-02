import { describe, expect, it } from 'vitest'
import { addExpense, DEFAULT_CATEGORIES, DomainError, type LedgerData } from '../domain'
import {
  ADMIN,
  DINNER_CATEGORY,
  fixtureLedger,
  LUNCH_CATEGORY,
  NOW,
  XIAOHONG,
} from '../domain/fixtures'
import {
  buildExpenseInput,
  type EntryForm,
  ensureCategories,
  formatCents,
  groupCategories,
  monthSummary,
  parseAmountToCents,
  recentExpenses,
  resolveCategoryName,
  splitTags,
  todayKey,
} from './entry'

function form(overrides: Partial<EntryForm> = {}): EntryForm {
  return {
    amountText: '12.5',
    parentId: 'cat-dining',
    categoryId: LUNCH_CATEGORY,
    date: '2026-10-02',
    note: '',
    tagsText: '',
    memberId: '',
    ...overrides,
  }
}

function ledgerWith(expenses: Array<Parameters<typeof addExpense>[1]>): LedgerData {
  const ledger = fixtureLedger()
  expenses.forEach((input, index) => {
    addExpense(ledger, input, {
      actor: XIAOHONG,
      now: `2026-10-02T0${index}:00:00.000Z`,
      newId: `e-${index}`,
    })
  })
  return ledger
}

describe('parseAmountToCents(元 → 整数分)', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['0.05', 5],
    ['0.5', 50],
    ['¥12.5', 1250],
    ['1,234.5', 123450],
    [' 8.00 ', 800],
  ])('解析 %s → %d 分', (text, expected) => {
    expect(parseAmountToCents(text)).toBe(expected)
  })

  it.each(['', ' ', '0', '0.00', 'abc', '-1', '1.234', '1.', '.5', '1e3', '１２'])(
    '拒绝非法输入 %s',
    (text) => {
      expect(() => parseAmountToCents(text)).toThrow(DomainError)
      expect(() => parseAmountToCents(text)).toThrow(/金额/)
    },
  )
})

describe('splitTags(标签拆分)', () => {
  it('按中英文逗号/顿号/空白拆分、去空、去重、保序', () => {
    expect(splitTags('微信, 支付宝,现金、微信 日常')).toEqual(['微信', '支付宝', '现金', '日常'])
  })

  it('空文本或只有分隔符 → 空数组', () => {
    expect(splitTags('')).toEqual([])
    expect(splitTags(' , ,、 ')).toEqual([])
  })
})

describe('todayKey(本地日期)', () => {
  it('返回本地时区的 YYYY-MM-DD,不受 UTC 偏移影响', () => {
    expect(todayKey(new Date(2026, 9, 2, 23, 30))).toBe('2026-10-02')
    expect(todayKey(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })
})

describe('groupCategories(两级分类)', () => {
  it('父分类按 sortOrder,子分类按父分组且有序', () => {
    const { parents, childrenByParent } = groupCategories(DEFAULT_CATEGORIES)

    expect(parents.map((c) => c.name).slice(0, 3)).toEqual(['餐饮', '交通', '购物'])
    expect(childrenByParent['cat-dining']?.map((c) => c.name)).toEqual([
      '早餐',
      '午餐',
      '晚餐',
      '外卖',
      '零食饮料',
    ])
    expect(childrenByParent['cat-nonexistent']).toBeUndefined()
  })
})

describe('buildExpenseInput(表单 → 领域输入)', () => {
  it('金额、日期、分类、备注与标签正确映射;经手人默认记录者本人', () => {
    const ledger = fixtureLedger()
    const input = buildExpenseInput(
      ledger,
      form({ note: ' 食堂 ', tagsText: '微信, 现金' }),
      XIAOHONG.id,
    )

    expect(input).toEqual({
      amountCents: 1250,
      date: '2026-10-02',
      categoryId: LUNCH_CATEGORY,
      tagNames: ['微信', '现金'],
      memberId: XIAOHONG.id,
      note: '食堂',
    })
  })

  it('代记:显式经手人优先;备注为空时省略字段', () => {
    const ledger = fixtureLedger()
    const input = buildExpenseInput(ledger, form({ memberId: ADMIN.id }), XIAOHONG.id)

    expect(input.memberId).toBe(ADMIN.id)
    expect(input.note).toBeUndefined()
  })

  it('父分类/未知分类/非法日期分别报错', () => {
    const ledger = fixtureLedger()
    expect(() =>
      buildExpenseInput(ledger, form({ categoryId: 'cat-dining' }), XIAOHONG.id),
    ).toThrow(/子分类/)
    expect(() =>
      buildExpenseInput(ledger, form({ categoryId: 'cat-missing' }), XIAOHONG.id),
    ).toThrow(/分类/)
    expect(() => buildExpenseInput(ledger, form({ date: '2026/10/02' }), XIAOHONG.id)).toThrow(
      /日期/,
    )
  })
})

describe('ensureCategories(默认分类兜底)', () => {
  it('空分类账本播种默认分类;已有分类不动', () => {
    const empty = fixtureLedger()
    empty.meta.categories = []
    ensureCategories(empty)
    expect(empty.meta.categories).toEqual(DEFAULT_CATEGORIES)

    const existing = fixtureLedger()
    ensureCategories(existing)
    expect(existing.meta.categories).toEqual(DEFAULT_CATEGORIES)
  })
})

describe('resolveCategoryName / formatCents', () => {
  it('账本分类优先,回退默认分类,未知给占位', () => {
    const ledger = fixtureLedger()
    expect(resolveCategoryName(ledger, LUNCH_CATEGORY)).toBe('午餐')

    const empty = fixtureLedger()
    empty.meta.categories = []
    expect(resolveCategoryName(empty, LUNCH_CATEGORY)).toBe('午餐')
    expect(resolveCategoryName(empty, 'cat-nope')).toBe('未知分类')
  })

  it('金额格式化保留两位小数', () => {
    expect(formatCents(1234)).toBe('¥12.34')
    expect(formatCents(5)).toBe('¥0.05')
    expect(formatCents(0)).toBe('¥0.00')
    expect(formatCents(100000)).toBe('¥1000.00')
  })
})

describe('monthSummary(本月累计与今日小计)', () => {
  it('本月合计、今日小计与笔数取自分组聚合', () => {
    const ledger = ledgerWith([
      { amountCents: 1200, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { amountCents: 800, date: '2026-10-02', categoryId: DINNER_CATEGORY, note: '面' },
      { amountCents: 5000, date: '2026-10-01', categoryId: LUNCH_CATEGORY },
      { amountCents: 9900, date: '2026-09-30', categoryId: LUNCH_CATEGORY },
    ])

    expect(monthSummary(ledger, '2026-10', '2026-10-02')).toEqual({
      monthTotalCents: 7000,
      todayTotalCents: 2000,
      todayCount: 2,
    })
    expect(monthSummary(ledger, '2026-10', '2026-10-05').todayTotalCents).toBe(0)
  })
})

describe('recentExpenses(最近记录)', () => {
  it('按日期倒序取前 N,同日按记录时间倒序', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-09-30', categoryId: LUNCH_CATEGORY },
      { amountCents: 200, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { amountCents: 300, date: '2026-10-01', categoryId: LUNCH_CATEGORY },
    ])

    const recent = recentExpenses(ledger, 5)
    expect(recent.map((e) => e.amountCents)).toEqual([200, 300, 100])
    expect(recentExpenses(ledger, 2)).toHaveLength(2)
  })
})

describe('端到端:表单输入写入账本(纯逻辑)', () => {
  it('代记 + 标签 + 默认分类兜底可完成一笔记录', () => {
    const ledger = fixtureLedger()
    ledger.meta.categories = []
    ensureCategories(ledger)
    const input = buildExpenseInput(
      ledger,
      form({ memberId: ADMIN.id, tagsText: '现金', amountText: '35' }),
      XIAOHONG.id,
    )
    addExpense(ledger, input, { actor: XIAOHONG, now: NOW, newId: 'e-added' })

    const expense = ledger.months['2026-10']?.expenses[0]
    expect(expense).toMatchObject({
      amountCents: 3500,
      memberId: ADMIN.id,
      recordedBy: XIAOHONG.id,
      tagNames: ['现金'],
    })
  })
})
