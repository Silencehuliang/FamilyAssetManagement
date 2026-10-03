import { describe, expect, it } from 'vitest'
import {
  addCategory,
  addExpense,
  type LedgerData,
  type TagGroup,
  type TagId,
  tagIdFromName,
} from '../domain'
import {
  ADMIN,
  DINNER_CATEGORY,
  fixtureLedger,
  LUNCH_CATEGORY,
  NOW,
  nextId,
  XIAOHONG,
} from '../domain/fixtures'
import {
  categoryChildrenShare,
  categoryShare,
  MERGED_CATEGORY_ID,
  memberShare,
  monthsInRange,
  monthTrend,
  tagDetailGroups,
  tagGroupSlices,
  tagSlices,
  trendTotalCents,
  UNGROUPED_GROUP_ID,
  UNTAGGED_SLICE_ID,
} from './stats'

function add(
  ledger: LedgerData,
  amountCents: number,
  date: string,
  categoryId: string,
  memberId?: string,
) {
  addExpense(
    ledger,
    { amountCents, date, categoryId, ...(memberId ? { memberId } : {}) },
    { actor: XIAOHONG, now: NOW, newId: nextId() },
  )
}

describe('monthsInRange / monthTrend', () => {
  it('三个预设分别取 1/3/12 个月,升序且跨年正确', () => {
    expect(monthsInRange('2026-10', 'thisMonth')).toEqual(['2026-10'])
    expect(monthsInRange('2026-10', 'last3Months')).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(monthsInRange('2026-01', 'last12Months')).toEqual([
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
    ])
  })

  it('无数据的月份补零,有数据的月份取聚合值', () => {
    const ledger = fixtureLedger()
    add(ledger, 1000, '2026-08-05', LUNCH_CATEGORY)
    add(ledger, 2000, '2026-10-01', LUNCH_CATEGORY)
    add(ledger, 500, '2026-10-02', LUNCH_CATEGORY)

    const points = monthTrend(ledger, monthsInRange('2026-10', 'last3Months'))

    expect(points).toEqual([
      { month: '2026-08', totalCents: 1000, count: 1 },
      { month: '2026-09', totalCents: 0, count: 0 },
      { month: '2026-10', totalCents: 2500, count: 2 },
    ])
    expect(trendTotalCents(points)).toBe(3500)
  })
})

describe('categoryShare', () => {
  function seeded(): LedgerData {
    const ledger = fixtureLedger()
    add(ledger, 3000, '2026-10-01', 'cat-dining-2') // 餐饮/午餐
    add(ledger, 1000, '2026-10-02', 'cat-dining-3') // 餐饮/晚餐
    add(ledger, 2000, '2026-10-03', 'cat-transport-2') // 交通/公共交通
    add(ledger, 500, '2026-09-30', 'cat-dining-2') // 范围外(上月)
    return ledger
  }

  it('父级视图把子分类金额聚合到父分类,并按金额降序', () => {
    const slices = categoryShare(seeded(), ['2026-10'], 'parent')

    expect(slices).toEqual([
      { id: 'cat-dining', name: '餐饮', totalCents: 4000, percent: 66.7 },
      { id: 'cat-transport', name: '交通', totalCents: 2000, percent: 33.3 },
    ])
  })

  it('子级视图按子分类展示,父分类不参与;分片名用「父/子」全路径', () => {
    const slices = categoryShare(seeded(), ['2026-10'], 'child')

    expect(slices.map((slice) => slice.id)).toEqual([
      'cat-dining-2',
      'cat-transport-2',
      'cat-dining-3',
    ])
    expect(slices[0]).toMatchObject({ name: '餐饮/午餐', totalCents: 3000 })
  })

  it('不同父分类下的同名子分类用全路径区分,图例/图表不互相覆盖', () => {
    const ledger = fixtureLedger()
    addCategory(ledger, ADMIN, { id: 'cat-dining-6', name: '咖啡', parentId: 'cat-dining' })
    addCategory(ledger, ADMIN, { id: 'cat-fun-4', name: '咖啡', parentId: 'cat-fun' })
    add(ledger, 3000, '2026-10-01', 'cat-dining-6')
    add(ledger, 1000, '2026-10-02', 'cat-fun-4')

    const slices = categoryShare(ledger, ['2026-10'], 'child')

    expect(slices.map((slice) => slice.id)).toEqual(['cat-dining-6', 'cat-fun-4'])
    expect(slices.map((slice) => slice.name)).toEqual(['餐饮/咖啡', '娱乐/咖啡'])
    expect(new Set(slices.map((slice) => slice.name)).size).toBe(slices.length)
  })

  it('超过 topN 的尾部合并为「其他」,percent 仍按全量计算', () => {
    const ledger = fixtureLedger()
    // 10 个父分类各一笔,金额 1000..100(递减)
    const childIds = [
      'cat-dining-2',
      'cat-transport-2',
      'cat-shopping-2',
      'cat-housing-2',
      'cat-fun-2',
      'cat-medical-2',
      'cat-education-2',
      'cat-social-2',
      'cat-pet-2',
      'cat-other-1',
    ]
    childIds.forEach((categoryId, index) => {
      add(ledger, 1000 - index * 100, '2026-10-05', categoryId)
    })

    const slices = categoryShare(ledger, ['2026-10'], 'parent', 8)

    expect(slices).toHaveLength(9)
    expect(slices[7]?.totalCents).toBe(300) // 第 8 名
    expect(slices[8]).toEqual({
      id: MERGED_CATEGORY_ID,
      name: '其他',
      totalCents: 300, // 尾部两笔 200 + 100
      percent: 5.5,
    })
    const centsSum = slices.reduce((sum, slice) => sum + slice.totalCents, 0)
    expect(centsSum).toBe(5500)
  })

  it('未知分类归入「未分类」;空范围返回空数组', () => {
    const ledger = fixtureLedger()
    // 分类被删除后历史记录可能仍指向旧 id:绕过领域校验直接注入
    ledger.months['2026-10'] = {
      expenses: [
        {
          id: 'e-gone',
          amountCents: 900,
          date: '2026-10-01',
          categoryId: 'cat-gone',
          tagIds: [],
          tagNames: [],
          memberId: XIAOHONG.id,
          recordedBy: XIAOHONG.id,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }

    expect(categoryShare(ledger, ['2026-10'], 'child')).toEqual([
      { id: 'cat-gone', name: '未分类', totalCents: 900, percent: 100 },
    ])
    expect(categoryShare(ledger, ['2026-01'], 'parent')).toEqual([])
  })
})

describe('memberShare', () => {
  it('按成员汇总金额与份额,金额降序且并列按名称稳定', () => {
    const ledger = fixtureLedger()
    add(ledger, 3000, '2026-10-01', LUNCH_CATEGORY) // 小红
    add(ledger, 1000, '2026-10-02', LUNCH_CATEGORY) // 小红
    add(ledger, 2000, '2026-10-03', LUNCH_CATEGORY, ADMIN.id)
    add(ledger, 4000, '2026-09-30', LUNCH_CATEGORY, ADMIN.id) // 范围外

    const slices = memberShare(ledger, ['2026-10'])

    expect(slices).toEqual([
      {
        id: XIAOHONG.id,
        name: '小红',
        totalCents: 4000,
        count: 2,
        percent: 66.7,
      },
      { id: ADMIN.id, name: '阿明', totalCents: 2000, count: 1, percent: 33.3 },
    ])
  })

  it('无人记账时返回空数组', () => {
    expect(memberShare(fixtureLedger(), ['2026-10'])).toEqual([])
  })
})

describe('categoryChildrenShare(分类下钻)', () => {
  it('只聚合该父分类下的子分类,percent 与父级视图同口径', () => {
    const ledger = fixtureLedger()
    add(ledger, 3000, '2026-10-01', LUNCH_CATEGORY)
    add(ledger, 1000, '2026-10-02', DINNER_CATEGORY)
    add(ledger, 2000, '2026-10-03', 'cat-transport-2') // 其他父分类,不参与

    const slices = categoryChildrenShare(ledger, ['2026-10'], 'cat-dining')

    expect(slices).toEqual([
      { id: LUNCH_CATEGORY, name: '午餐', totalCents: 3000, percent: 50 },
      { id: DINNER_CATEGORY, name: '晚餐', totalCents: 1000, percent: 16.7 },
    ])
    expect(categoryChildrenShare(ledger, ['2026-10'], 'cat-missing')).toEqual([])
  })
})

/** 带标签实体与标签组的账本:微信/现金 ∈ 支付方式(blue),日用 未分组 */
async function taggedLedger(): Promise<{
  ledger: LedgerData
  wechat: TagId
  cash: TagId
  daily: TagId
}> {
  const ledger = fixtureLedger()
  const wechat = await tagIdFromName('微信')
  const cash = await tagIdFromName('现金')
  const daily = await tagIdFromName('日用')
  ledger.meta.tags = [
    { id: wechat, name: '微信', updatedAt: NOW },
    { id: cash, name: '现金', updatedAt: NOW },
    { id: daily, name: '日用', updatedAt: NOW },
  ]
  const payment: TagGroup = {
    id: 'grp-pay',
    name: '支付方式',
    color: 'blue',
    tagIds: [wechat, cash],
    singleSelect: true,
  }
  ledger.meta.tagGroups = [payment]

  const record = (amountCents: number, date: string, categoryId: string, tagIds: TagId[]) => {
    addExpense(
      ledger,
      { amountCents, date, categoryId, tagIds },
      { actor: XIAOHONG, now: NOW, newId: nextId() },
    )
  }
  record(1000, '2026-10-01', LUNCH_CATEGORY, [wechat])
  record(2000, '2026-10-02', DINNER_CATEGORY, [cash, daily]) // 一鱼两标签
  record(500, '2026-10-03', LUNCH_CATEGORY, []) // 未标记
  record(300, '2026-09-30', LUNCH_CATEGORY, [wechat]) // 范围外
  return { ledger, wechat, cash, daily }
}

describe('tagGroupSlices / tagSlices(标签维度,V9)', () => {
  it('按组聚合:组色着色,未归组进「未分组」,无标签进「未标记」,金额降序', async () => {
    const { ledger } = await taggedLedger()

    const slices = tagGroupSlices(ledger, ['2026-10'])

    expect(slices).toEqual([
      {
        id: 'grp-pay',
        name: '支付方式',
        totalCents: 3000,
        count: 2,
        percent: 85.7,
        color: 'var(--tag-blue)',
      },
      {
        id: UNGROUPED_GROUP_ID,
        name: '未分组',
        totalCents: 2000,
        count: 1,
        percent: 57.1,
        color: 'var(--tag-gray)',
      },
      {
        id: UNTAGGED_SLICE_ID,
        name: '未标记',
        totalCents: 500,
        count: 1,
        percent: 14.3,
        color: 'var(--muted-foreground)',
      },
    ])
  })

  it('超过 topN 的尾部合并「其他」;范围内无数据返回空数组', async () => {
    const { ledger } = await taggedLedger()

    const merged = tagGroupSlices(ledger, ['2026-10'], 2)
    expect(merged.map((slice) => slice.id)).toEqual([
      'grp-pay',
      UNGROUPED_GROUP_ID,
      MERGED_CATEGORY_ID,
    ])
    expect(merged[2]).toMatchObject({ name: '其他', totalCents: 500, count: 1, percent: 14.3 })

    expect(tagGroupSlices(ledger, ['2026-08'])).toEqual([])
    expect(tagGroupSlices(fixtureLedger(), ['2026-10'])).toEqual([])
  })

  it('下钻到组内标签;未分组合成组列出无组标签;未知组返回空', async () => {
    const { ledger, wechat, cash, daily } = await taggedLedger()

    const pay = tagSlices(ledger, ['2026-10'], 'grp-pay')
    expect(pay).toEqual([
      {
        id: cash,
        name: '现金',
        totalCents: 2000,
        count: 1,
        percent: 57.1,
        color: 'var(--tag-blue)',
      },
      {
        id: wechat,
        name: '微信',
        totalCents: 1000,
        count: 1,
        percent: 28.6,
        color: 'var(--tag-blue)',
      },
    ])

    expect(tagSlices(ledger, ['2026-10'], UNGROUPED_GROUP_ID)).toEqual([
      {
        id: daily,
        name: '日用',
        totalCents: 2000,
        count: 1,
        percent: 57.1,
        color: 'var(--tag-gray)',
      },
    ])
    expect(tagSlices(ledger, ['2026-10'], 'grp-missing')).toEqual([])
  })

  it('悬空 tagId 静默过滤并按未标记处理(不计入任何标签/组)', async () => {
    const ledger = fixtureLedger()
    // 实体被删除后的悬空引用:绕过领域校验直接注入(与 categoryShare 的旧数据用例一致)
    ledger.months['2026-10'] = {
      expenses: [
        {
          id: 'e-dangling',
          amountCents: 800,
          date: '2026-10-01',
          categoryId: LUNCH_CATEGORY,
          tagIds: ['tag-missing'],
          tagNames: [],
          memberId: XIAOHONG.id,
          recordedBy: XIAOHONG.id,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }

    const slices = tagGroupSlices(ledger, ['2026-10'])
    expect(slices).toEqual([
      {
        id: UNTAGGED_SLICE_ID,
        name: '未标记',
        totalCents: 800,
        count: 1,
        percent: 100,
        color: 'var(--muted-foreground)',
      },
    ])
  })
})

describe('tagDetailGroups(标签明细表,V9)', () => {
  it('组 → 标签两行列金额/笔数/占比,组按金额降序,行按金额降序', async () => {
    const { ledger, wechat, cash, daily } = await taggedLedger()

    const groups = tagDetailGroups(ledger, ['2026-10'])

    expect(groups.map((group) => group.id)).toEqual(['grp-pay', UNGROUPED_GROUP_ID])
    expect(groups[0]).toMatchObject({
      name: '支付方式',
      color: 'var(--tag-blue)',
      totalCents: 3000,
      count: 2,
    })
    expect(groups[0]?.rows).toEqual([
      { tagId: cash, name: '现金', totalCents: 2000, count: 1, percent: 57.1 },
      { tagId: wechat, name: '微信', totalCents: 1000, count: 1, percent: 28.6 },
    ])
    expect(groups[1]?.rows).toEqual([
      { tagId: daily, name: '日用', totalCents: 2000, count: 1, percent: 57.1 },
    ])
    expect(tagDetailGroups(fixtureLedger(), ['2026-10'])).toEqual([])
  })
})
