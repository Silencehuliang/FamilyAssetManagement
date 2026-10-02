import { describe, expect, it } from 'vitest'
import { addExpense, DEFAULT_CATEGORIES, type LedgerData } from '../domain'
import {
  ADMIN,
  DALI,
  DINNER_CATEGORY,
  fixtureLedger,
  LUNCH_CATEGORY,
  XIAOHONG,
} from '../domain/fixtures'
import {
  canEditEntry,
  EMPTY_FILTERS,
  type EntryFilters,
  expenseToForm,
  filterExpenses,
  formatAmountInput,
  formatMonthLabel,
  groupByDay,
  hasActiveFilters,
  monthOptions,
  shiftMonth,
  sumCents,
  tagsOfMonth,
} from './entries'

function ledgerWith(
  expenses: Array<Parameters<typeof addExpense>[1] & { actor?: typeof XIAOHONG }>,
): LedgerData {
  const ledger = fixtureLedger()
  expenses.forEach((input, index) => {
    const { actor = XIAOHONG, ...rest } = input
    addExpense(ledger, rest, {
      actor,
      now: `2026-10-02T0${index}:00:00.000Z`,
      newId: `e-${index}`,
    })
  })
  return ledger
}

function filters(overrides: Partial<EntryFilters> = {}): EntryFilters {
  return { ...EMPTY_FILTERS, ...overrides }
}

describe('filterExpenses(组合筛选)', () => {
  const ledger = ledgerWith([
    // e-0:小红 午餐 微信 备注「楼下超市」
    {
      amountCents: 1250,
      date: '2026-10-02',
      categoryId: LUNCH_CATEGORY,
      tagNames: ['微信', '日用'],
      note: '楼下超市',
    },
    // e-1:代阿明记 晚餐 现金 无备注
    {
      amountCents: 8800,
      date: '2026-10-03',
      categoryId: DINNER_CATEGORY,
      tagNames: ['现金'],
      memberId: ADMIN.id,
    },
    // e-2:大力 交通-打车,无标签,备注「机场」
    {
      amountCents: 5600,
      date: '2026-09-28',
      categoryId: 'cat-transport-2',
      memberId: DALI.id,
      note: '机场',
    },
  ])
  const all = Object.values(ledger.months).flatMap((month) => month.expenses)
  const ids = (list: ReturnType<typeof filterExpenses>) => list.map((e) => e.id).sort()

  it('无筛选返回全部;hasActiveFilters 能识别任一条件', () => {
    expect(filterExpenses(ledger, all, EMPTY_FILTERS)).toHaveLength(3)
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false)
    expect(hasActiveFilters(filters({ keyword: '  ' }))).toBe(false)
    expect(hasActiveFilters(filters({ tag: '微信' }))).toBe(true)
  })

  it('按子分类精确筛选;按父分类匹配其全部子分类', () => {
    expect(ids(filterExpenses(ledger, all, filters({ categoryId: LUNCH_CATEGORY })))).toEqual([
      'e-0',
    ])
    expect(ids(filterExpenses(ledger, all, filters({ parentId: 'cat-dining' })))).toEqual([
      'e-0',
      'e-1',
    ])
    // 指定子分类时父分类条件不再参与匹配(子分类优先)
    expect(
      ids(
        filterExpenses(
          ledger,
          all,
          filters({ parentId: 'cat-transport', categoryId: LUNCH_CATEGORY }),
        ),
      ),
    ).toEqual(['e-0'])
  })

  it('按经手人筛选(代记时归经手人)', () => {
    expect(ids(filterExpenses(ledger, all, filters({ memberId: ADMIN.id })))).toEqual(['e-1'])
  })

  it('按标签精确筛选', () => {
    expect(ids(filterExpenses(ledger, all, filters({ tag: '微信' })))).toEqual(['e-0'])
    expect(filterExpenses(ledger, all, filters({ tag: '日' }))).toHaveLength(0)
  })

  it('关键词命中备注、分类名(含父分类)与标签,忽略大小写', () => {
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '超市' })))).toEqual(['e-0'])
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '晚餐' })))).toEqual(['e-1'])
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '交通' })))).toEqual(['e-2'])
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '现金' })))).toEqual(['e-1'])
    expect(filterExpenses(ledger, all, filters({ keyword: '不存在' }))).toHaveLength(0)
  })

  it('四种筛选可组合,彼此为与关系', () => {
    expect(
      ids(
        filterExpenses(
          ledger,
          all,
          filters({ parentId: 'cat-dining', memberId: XIAOHONG.id, tag: '微信', keyword: '超市' }),
        ),
      ),
    ).toEqual(['e-0'])
    // 组合中任一条不满足即为空
    expect(
      filterExpenses(
        ledger,
        all,
        filters({ parentId: 'cat-dining', memberId: ADMIN.id, tag: '微信' }),
      ),
    ).toHaveLength(0)
  })
})

describe('groupByDay / sumCents(按日分组与汇总)', () => {
  it('按日倒序分组,组内按记录时间倒序,日小计等于组内金额和', () => {
    const ledger = ledgerWith([
      { amountCents: 1000, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      { amountCents: 250, date: '2026-10-02', categoryId: DINNER_CATEGORY },
      { amountCents: 9900, date: '2026-10-05', categoryId: LUNCH_CATEGORY },
    ])
    const all = Object.values(ledger.months).flatMap((month) => month.expenses)

    const groups = groupByDay(all)

    expect(groups.map((g) => g.date)).toEqual(['2026-10-05', '2026-10-02'])
    expect(groups[1]?.totalCents).toBe(1250)
    expect(groups[0]?.totalCents).toBe(9900)
    // 同日两条:后记的 e-1 在前
    expect(groups[1]?.expenses.map((e) => e.id)).toEqual(['e-1', 'e-0'])
    expect(sumCents(all)).toBe(11150)
    expect(groupByDay([])).toEqual([])
    expect(sumCents([])).toBe(0)
  })
})

describe('月份选项与切换', () => {
  it('有数据的月份与当前月/选中月并集,倒序并标记数据', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-08-10', categoryId: LUNCH_CATEGORY },
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
    ])

    const options = monthOptions(ledger, '2026-10', '2026-10')

    expect(options.map((o) => o.month)).toEqual(['2026-10', '2026-08'])
    expect(options.map((o) => o.hasData)).toEqual([true, true])
    expect(options[0]?.label).toBe('2026年10月')
  })

  it('切到空月份时该月仍作为选项存在(hasData=false)', () => {
    const ledger = fixtureLedger()
    const options = monthOptions(ledger, '2026-07', '2026-10')
    expect(options.map((o) => o.month)).toEqual(['2026-10', '2026-07'])
    expect(options[1]?.hasData).toBe(false)
  })

  it('shiftMonth 跨年前后切换', () => {
    expect(shiftMonth('2026-10', 1)).toBe('2026-11')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(formatMonthLabel('2026-10')).toBe('2026年10月')
    expect(formatMonthLabel('2026-01')).toBe('2026年1月')
  })

  it('tagsOfMonth 返回该月出现过的去重标签', () => {
    const ledger = ledgerWith([
      {
        amountCents: 100,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信', '日用'],
      },
      { amountCents: 100, date: '2026-10-03', categoryId: DINNER_CATEGORY, tagNames: ['微信'] },
      { amountCents: 100, date: '2026-09-03', categoryId: DINNER_CATEGORY, tagNames: ['现金'] },
    ])
    expect(tagsOfMonth(ledger, '2026-10')).toEqual(['日用', '微信'])
    expect(tagsOfMonth(ledger, '2026-09')).toEqual(['现金'])
    expect(tagsOfMonth(ledger, '2026-08')).toEqual([])
  })
})

describe('权限门禁(自我编辑)', () => {
  it('成员只能编辑自己的,管理员可编辑任何记录', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
      {
        amountCents: 200,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        memberId: ADMIN.id,
        actor: ADMIN,
      },
    ])
    const all = Object.values(ledger.months).flatMap((month) => month.expenses)
    const mine = all.find((e) => e.id === 'e-0')
    const others = all.find((e) => e.id === 'e-1')
    if (!mine || !others) throw new Error('fixture: 支出缺失')

    expect(canEditEntry(XIAOHONG, mine)).toBe(true)
    expect(canEditEntry(XIAOHONG, others)).toBe(false)
    expect(canEditEntry(ADMIN, others)).toBe(true)
    expect(canEditEntry(DALI, mine)).toBe(false)
  })
})

describe('expenseToForm / formatAmountInput(编辑回填)', () => {
  it.each([
    [1250, '12.5'],
    [1205, '12.05'],
    [1200, '12'],
    [5, '0.05'],
    [100000, '1000'],
  ])('整数分 %d → 输入文本 %s', (cents, text) => {
    expect(formatAmountInput(cents)).toBe(text)
  })

  it('支出回填为表单初值:父分类、标签与备注还原', () => {
    const ledger = ledgerWith([
      {
        amountCents: 1250,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信', '日用'],
        note: '楼下超市',
      },
    ])
    const expense = Object.values(ledger.months)[0]?.expenses[0]
    if (!expense) throw new Error('fixture: 支出缺失')

    expect(expenseToForm(ledger, expense)).toEqual({
      amountText: '12.5',
      parentId: 'cat-dining',
      categoryId: LUNCH_CATEGORY,
      date: '2026-10-02',
      note: '楼下超市',
      tagsText: '微信, 日用',
      memberId: XIAOHONG.id,
    })
  })

  it('分类已被删除时父分类留空,分类 id 原样保留', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY },
    ])
    const expense = Object.values(ledger.months)[0]?.expenses[0]
    if (!expense) throw new Error('fixture: 支出缺失')
    ledger.meta.categories = structuredClone(
      DEFAULT_CATEGORIES.filter((c) => c.id !== LUNCH_CATEGORY),
    )

    const form = expenseToForm(ledger, expense)
    expect(form.parentId).toBe('')
    expect(form.categoryId).toBe(LUNCH_CATEGORY)
  })
})
