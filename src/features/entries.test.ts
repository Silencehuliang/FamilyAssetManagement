import { describe, expect, it } from 'vitest'
import { addExpense, DEFAULT_CATEGORIES, type LedgerData, tagIdFromName } from '../domain'
import {
  ADMIN,
  DALI,
  DINNER_CATEGORY,
  fixtureLedger,
  LUNCH_CATEGORY,
  NOW,
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
  tagChipsOf,
  tagFilterGroups,
  UNGROUPED_FILTER_GROUP_ID,
} from './entries'

/** 测试用标签实体 id(迁移后的稳定 id 形状) */
const TAG_WECHAT = 'tag-wechat'
const TAG_CASH = 'tag-cash'
const TAG_DAILY = 'tag-daily'
const TAG_OUT = 'tag-out'

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
  // 迁移后的标签实体(旧 tagNames 记录经名字回退映射到实体,保证按 id 筛选)
  ledger.meta.tags = [
    { id: TAG_WECHAT, name: '微信', updatedAt: NOW },
    { id: TAG_DAILY, name: '日用', updatedAt: NOW },
    { id: TAG_CASH, name: '现金', updatedAt: NOW },
  ]
  const all = Object.values(ledger.months).flatMap((month) => month.expenses)
  const ids = (list: ReturnType<typeof filterExpenses>) => list.map((e) => e.id).sort()

  it('无筛选返回全部;hasActiveFilters 能识别任一条件', () => {
    expect(filterExpenses(ledger, all, EMPTY_FILTERS)).toHaveLength(3)
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false)
    expect(hasActiveFilters(filters({ keyword: '  ' }))).toBe(false)
    expect(hasActiveFilters(filters({ tagIds: [TAG_WECHAT] }))).toBe(true)
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

  it('标签包含:任一选中标签命中即保留', () => {
    expect(ids(filterExpenses(ledger, all, filters({ tagIds: [TAG_WECHAT] })))).toEqual(['e-0'])
    expect(ids(filterExpenses(ledger, all, filters({ tagIds: [TAG_WECHAT, TAG_CASH] })))).toEqual([
      'e-0',
      'e-1',
    ])
    expect(filterExpenses(ledger, all, filters({ tagIds: [TAG_DAILY] }))).toHaveLength(1)
    // 未匹配任何标签(日用只在 e-0,但组合成员条件后为空)
    expect(
      filterExpenses(ledger, all, filters({ tagIds: [TAG_DAILY], memberId: ADMIN.id })),
    ).toHaveLength(0)
  })

  it('标签排除:剔除带任一选中标签的支出', () => {
    expect(
      ids(filterExpenses(ledger, all, filters({ tagIds: [TAG_WECHAT], tagMode: 'exclude' }))),
    ).toEqual(['e-1', 'e-2'])
    expect(
      ids(filterExpenses(ledger, all, filters({ tagIds: [TAG_DAILY], tagMode: 'exclude' }))),
    ).toEqual(['e-1', 'e-2'])
    expect(
      ids(
        filterExpenses(
          ledger,
          all,
          filters({ tagIds: [TAG_WECHAT, TAG_CASH, TAG_DAILY], tagMode: 'exclude' }),
        ),
      ),
    ).toEqual(['e-2'])
  })

  it('悬空/未知标签 id:包含为空,排除保留全部;空选择两种模式都不过滤', () => {
    expect(filterExpenses(ledger, all, filters({ tagIds: ['tag-missing'] }))).toHaveLength(0)
    expect(
      ids(filterExpenses(ledger, all, filters({ tagIds: ['tag-missing'], tagMode: 'exclude' }))),
    ).toEqual(['e-0', 'e-1', 'e-2'])
    expect(filterExpenses(ledger, all, filters({ tagIds: [], tagMode: 'exclude' }))).toHaveLength(3)
  })

  it('关键词命中备注、分类名(含父分类)与标签,忽略大小写', () => {
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '超市' })))).toEqual(['e-0'])
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '晚餐' })))).toEqual(['e-1'])
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '交通' })))).toEqual(['e-2'])
    expect(ids(filterExpenses(ledger, all, filters({ keyword: '现金' })))).toEqual(['e-1'])
    expect(filterExpenses(ledger, all, filters({ keyword: '不存在' }))).toHaveLength(0)
  })

  it('标签与分类/成员/关键词可组合,彼此为与关系', () => {
    expect(
      ids(
        filterExpenses(
          ledger,
          all,
          filters({
            parentId: 'cat-dining',
            memberId: XIAOHONG.id,
            tagIds: [TAG_WECHAT],
            keyword: '超市',
          }),
        ),
      ),
    ).toEqual(['e-0'])
    // 排除模式同样可与其它条件组合:「餐饮父类下,剔除带微信的」
    expect(
      ids(
        filterExpenses(
          ledger,
          all,
          filters({ parentId: 'cat-dining', tagIds: [TAG_WECHAT], tagMode: 'exclude' }),
        ),
      ),
    ).toEqual(['e-1'])
    // 组合中任一条不满足即为空
    expect(
      filterExpenses(
        ledger,
        all,
        filters({ parentId: 'cat-dining', memberId: ADMIN.id, tagIds: [TAG_WECHAT] }),
      ),
    ).toHaveLength(0)
  })
})

describe('tagFilterGroups(按组筛选选项,V10)', () => {
  it('只列该月出现过的标签,按标签组分组,未归组殿后;空月返回空数组', () => {
    const ledger = ledgerWith([
      {
        amountCents: 100,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信', '日用'],
      },
      { amountCents: 200, date: '2026-10-03', categoryId: DINNER_CATEGORY, tagNames: ['现金'] },
      { amountCents: 300, date: '2026-09-03', categoryId: DINNER_CATEGORY, tagNames: ['出行'] },
    ])
    ledger.meta.tags = [
      { id: TAG_WECHAT, name: '微信', updatedAt: NOW },
      { id: TAG_CASH, name: '现金', updatedAt: NOW },
      { id: TAG_DAILY, name: '日用', updatedAt: NOW },
      { id: TAG_OUT, name: '出行', updatedAt: NOW },
    ]
    ledger.meta.tagGroups = [
      { id: 'grp-pay', name: '支付方式', color: 'blue', tagIds: [TAG_WECHAT, TAG_CASH] },
      { id: 'grp-life', name: '生活', color: 'green', tagIds: [] }, // 空组不显示
    ]

    const groups = tagFilterGroups(ledger, '2026-10')

    expect(groups).toEqual([
      {
        id: 'grp-pay',
        name: '支付方式',
        color: 'blue',
        tags: [
          { id: TAG_WECHAT, name: '微信' },
          { id: TAG_CASH, name: '现金' },
        ],
      },
      { id: UNGROUPED_FILTER_GROUP_ID, name: '未分组', tags: [{ id: TAG_DAILY, name: '日用' }] },
    ])
    // 9 月只出现「出行」,它不在 10 月选项里
    expect(tagFilterGroups(ledger, '2026-09')).toEqual([
      { id: UNGROUPED_FILTER_GROUP_ID, name: '未分组', tags: [{ id: TAG_OUT, name: '出行' }] },
    ])
    expect(tagFilterGroups(fixtureLedger(), '2026-10')).toEqual([])
  })

  it('presetTagIds 即使当月无支出也保留为选项,跳转预置的 chip 不消失', () => {
    const ledger = ledgerWith([
      { amountCents: 200, date: '2026-09-03', categoryId: DINNER_CATEGORY, tagNames: ['微信'] },
    ])
    ledger.meta.tags = [
      { id: TAG_WECHAT, name: '微信', updatedAt: NOW },
      { id: TAG_CASH, name: '现金', updatedAt: NOW },
      { id: TAG_DAILY, name: '日用', updatedAt: NOW },
    ]
    ledger.meta.tagGroups = [
      { id: 'grp-pay', name: '支付方式', color: 'blue', tagIds: [TAG_WECHAT, TAG_CASH] },
    ]

    // 2026-10 无任何支出:预置的微信/日用仍以实体名出现在各自分组里
    expect(tagFilterGroups(ledger, '2026-10', [TAG_WECHAT, TAG_DAILY])).toEqual([
      {
        id: 'grp-pay',
        name: '支付方式',
        color: 'blue',
        tags: [{ id: TAG_WECHAT, name: '微信' }],
      },
      { id: UNGROUPED_FILTER_GROUP_ID, name: '未分组', tags: [{ id: TAG_DAILY, name: '日用' }] },
    ])
    // 不预置时保持原行为(空月为空);悬空预置 id 忽略,不产生空组
    expect(tagFilterGroups(ledger, '2026-10')).toEqual([])
    expect(tagFilterGroups(ledger, '2026-10', ['tag-missing'])).toEqual([])
  })
})

describe('tagChipsOf / EntryView.tagChips(行内标签组色,V10)', () => {
  it('tagIds 解析出组色;未归组无色;悬空 id 过滤', async () => {
    const ledger = fixtureLedger()
    const wechat = await tagIdFromName('微信')
    const daily = await tagIdFromName('日用')
    ledger.meta.tags = [
      { id: wechat, name: '微信', updatedAt: NOW },
      { id: daily, name: '日用', updatedAt: NOW },
    ]
    ledger.meta.tagGroups = [{ id: 'grp-pay', name: '支付方式', color: 'purple', tagIds: [wechat] }]
    addExpense(
      ledger,
      {
        amountCents: 1250,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagIds: [wechat, daily],
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-chips' },
    )
    const expense = ledger.months['2026-10']?.expenses[0]
    if (!expense) throw new Error('fixture: 支出缺失')
    // 模拟实体被删除后的悬空引用(并集合并/旧数据可能出现):chips 读取时静默过滤
    expense.tagIds = [wechat, daily, 'tag-missing']

    expect(tagChipsOf(ledger, expense)).toEqual([
      { id: wechat, name: '微信', color: 'purple' },
      { id: daily, name: '日用' },
    ])
    expect(groupByDay(ledger, [expense])[0]?.expenses[0]?.tagChips).toEqual([
      { id: wechat, name: '微信', color: 'purple' },
      { id: daily, name: '日用' },
    ])
  })

  it('旧 tagNames 记录按名字回退到同名实体的组色', () => {
    const ledger = ledgerWith([
      {
        amountCents: 100,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagNames: ['微信'],
      },
    ])
    ledger.meta.tags = [{ id: TAG_WECHAT, name: '微信', updatedAt: NOW }]
    ledger.meta.tagGroups = [
      { id: 'grp-pay', name: '支付方式', color: 'red', tagIds: [TAG_WECHAT] },
    ]
    const expense = Object.values(ledger.months)[0]?.expenses[0]
    if (!expense) throw new Error('fixture: 支出缺失')

    expect(tagChipsOf(ledger, expense)).toEqual([{ id: TAG_WECHAT, name: '微信', color: 'red' }])
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

    const groups = groupByDay(ledger, all)

    expect(groups.map((g) => g.date)).toEqual(['2026-10-05', '2026-10-02'])
    expect(groups[1]?.totalCents).toBe(1250)
    expect(groups[0]?.totalCents).toBe(9900)
    // 同日两条:后记的 e-1 在前
    expect(groups[1]?.expenses.map((e) => e.id)).toEqual(['e-1', 'e-0'])
    expect(sumCents(all)).toBe(11150)
    expect(groupByDay(fixtureLedger(), [])).toEqual([])
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

  it('旧数据兼容回退:只有 v1 tagNames 时迁移完成前也能回填', () => {
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

describe('标签实体解析(读路径,评审修复)', () => {
  it('tagIds 经账本实体解析为名字:筛选/月标签/按日视图/表单回填;悬空 id 静默过滤', async () => {
    const ledger = fixtureLedger()
    const wechat = await tagIdFromName('微信')
    const cash = await tagIdFromName('现金')
    ledger.meta.tags = [
      { id: cash, name: '现金', updatedAt: NOW },
      { id: wechat, name: '微信', updatedAt: NOW },
    ]
    addExpense(
      ledger,
      {
        amountCents: 1250,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagIds: [wechat],
        note: '楼下超市',
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-tagged' },
    )
    const tagged = ledger.months['2026-10']?.expenses[0]
    if (!tagged) throw new Error('fixture: 支出缺失')
    // 模拟实体被删除后的悬空引用(并集合并/旧数据可能出现):读取时静默过滤
    tagged.tagIds = [wechat, 'tag-missing']
    const all = Object.values(ledger.months).flatMap((month) => month.expenses)

    expect(filterExpenses(ledger, all, filters({ tagIds: [wechat] })).map((e) => e.id)).toEqual([
      'e-tagged',
    ])
    expect(filterExpenses(ledger, all, filters({ tagIds: ['tag-missing'] }))).toHaveLength(0)
    expect(filterExpenses(ledger, all, filters({ keyword: '现金' }))).toHaveLength(0)
    expect(expenseToForm(ledger, tagged).tagsText).toBe('微信')
    expect(groupByDay(ledger, all)[0]?.expenses[0]?.tagNames).toEqual(['微信'])
    expect(groupByDay(ledger, all)[0]?.expenses[0]?.tagChips).toEqual([
      { id: wechat, name: '微信' },
    ])
  })
})
