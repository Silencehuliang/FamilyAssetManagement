import { describe, expect, it } from 'vitest'
import { addExpense, type LedgerData } from '../domain'
import { ADMIN, fixtureLedger, LUNCH_CATEGORY, NOW, nextId, XIAOHONG } from '../domain/fixtures'
import {
  categoryShare,
  MERGED_CATEGORY_ID,
  memberShare,
  monthsInRange,
  monthTrend,
  trendTotalCents,
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

  it('子级视图按子分类展示,父分类不参与', () => {
    const slices = categoryShare(seeded(), ['2026-10'], 'child')

    expect(slices.map((slice) => slice.id)).toEqual([
      'cat-dining-2',
      'cat-transport-2',
      'cat-dining-3',
    ])
    expect(slices[0]).toMatchObject({ name: '午餐', totalCents: 3000 })
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
