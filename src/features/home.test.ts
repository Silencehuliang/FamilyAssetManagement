import { describe, expect, it } from 'vitest'
import { addExpense, type LedgerData, setTotalBudget } from '../domain'
import { ADMIN, fixtureLedger, LUNCH_CATEGORY, XIAOHONG } from '../domain/fixtures'
import {
  activeDotIndex,
  budgetWidget,
  categoryAccent,
  homeBillGroups,
  homeDayLabel,
  homeDonut,
  homeSummary,
} from './home'

interface ExpenseSpec {
  amountCents: number
  date: string
  note?: string
}

function ledgerWith(expenses: ExpenseSpec[]): LedgerData {
  const ledger = fixtureLedger()
  expenses.forEach((item, index) => {
    addExpense(
      ledger,
      {
        amountCents: item.amountCents,
        date: item.date,
        categoryId: LUNCH_CATEGORY,
        tagNames: [],
        memberId: XIAOHONG.id,
        note: item.note,
      },
      {
        actor: XIAOHONG,
        now: `2026-10-03T${String(index).padStart(2, '0')}:00:00.000Z`,
        newId: `e-${index}`,
      },
    )
  })
  return ledger
}

describe('homeSummary(今日/本月汇总)', () => {
  it('今日取当天日分组,本月含所有日期', () => {
    const ledger = ledgerWith([
      { amountCents: 500, date: '2026-10-03' },
      { amountCents: 300, date: '2026-10-03' },
      { amountCents: 100, date: '2026-10-01' },
      { amountCents: 700, date: '2026-09-30' },
    ])

    expect(homeSummary(ledger, '2026-10-03')).toEqual({
      todayTotalCents: 800,
      todayCount: 2,
      monthTotalCents: 900,
      monthCount: 3,
    })
  })

  it('无数据时全为 0', () => {
    expect(homeSummary(fixtureLedger(), '2026-10-03')).toEqual({
      todayTotalCents: 0,
      todayCount: 0,
      monthTotalCents: 0,
      monthCount: 0,
    })
  })
})

describe('budgetWidget(预算进度小组件)', () => {
  it('未设置总预算返回 null', () => {
    const ledger = ledgerWith([{ amountCents: 500, date: '2026-10-03' }])
    expect(budgetWidget(ledger, '2026-10')).toBeNull()
  })

  it('设置总预算后给出百分比与余量', () => {
    const ledger = ledgerWith([{ amountCents: 900, date: '2026-10-03' }])
    setTotalBudget(ledger, ADMIN, '2026-10', 1000)

    expect(budgetWidget(ledger, '2026-10')).toEqual({
      totalCents: 1000,
      spentCents: 900,
      remainingCents: 100,
      overspent: false,
      percent: 90,
    })
  })

  it('超支时 percent 截断在 100,remaining 为负', () => {
    const ledger = ledgerWith([{ amountCents: 2000, date: '2026-10-03' }])
    setTotalBudget(ledger, ADMIN, '2026-10', 1000)

    const widget = budgetWidget(ledger, '2026-10')
    expect(widget?.percent).toBe(100)
    expect(widget?.overspent).toBe(true)
    expect(widget?.remainingCents).toBe(-1000)
  })
})

describe('homeBillGroups(账单流)', () => {
  it('按日期倒序分组、日小计正确,并遵守条数上限', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-10-01' },
      { amountCents: 200, date: '2026-10-02' },
      { amountCents: 300, date: '2026-10-03' },
      { amountCents: 400, date: '2026-10-03' },
      { amountCents: 500, date: '2026-10-02' },
    ])

    const groups = homeBillGroups(ledger, 3)
    expect(groups.map((group) => group.date)).toEqual(['2026-10-03', '2026-10-02'])
    expect(groups[0]?.totalCents).toBe(700)
    expect(groups[0]?.expenses.map((expense) => expense.amountCents)).toEqual([400, 300])
    // limit=3 只保留最新三笔:10-03 两笔 + 10-02 的 500;
    // 但 10-02 的日小计仍按当天全部支出(200 + 500)计算
    expect(groups[1]?.totalCents).toBe(700)
    expect(groups[1]?.expenses.map((expense) => expense.amountCents)).toEqual([500])
  })

  it('日小计覆盖当天全部支出,不随展示截断而缩小', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-10-03' },
      { amountCents: 200, date: '2026-10-03' },
      { amountCents: 300, date: '2026-10-03' },
      { amountCents: 400, date: '2026-10-03' },
      { amountCents: 500, date: '2026-10-03' },
      { amountCents: 600, date: '2026-10-02' },
    ])

    const groups = homeBillGroups(ledger, 2)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.expenses).toHaveLength(2)
    expect(groups[0]?.totalCents).toBe(1500)

    // 未进入展示集合的日期不产出分组
    const one = homeBillGroups(ledger, 1)
    expect(one.map((group) => group.date)).toEqual(['2026-10-03'])
  })

  it('空账本返回空数组', () => {
    expect(homeBillGroups(fixtureLedger())).toEqual([])
  })
})

describe('activeDotIndex(小组件分页圆点)', () => {
  it('取离 rail 视口中心最近的子元素(同一坐标系)', () => {
    const centers = [40, 320, 600]
    expect(activeDotIndex(0, 280, centers)).toBe(0)
    expect(activeDotIndex(180, 280, centers)).toBe(1)
    expect(activeDotIndex(460, 280, centers)).toBe(2)
  })

  it('回归:document 空间的偏移不应参与比较(以 rail 相对偏移为准)', () => {
    // 子元素中心相对 rail 滚动内容左缘为 16/336/656;视口中心 170
    expect(activeDotIndex(10, 320, [16, 336, 656])).toBe(0)
    expect(activeDotIndex(176, 320, [16, 336, 656])).toBe(1)
  })

  it('空数组回退 0,距离并列时取靠前下标', () => {
    expect(activeDotIndex(0, 300, [])).toBe(0)
    expect(activeDotIndex(50, 100, [0, 200])).toBe(0)
  })
})

describe('homeDayLabel(日期标签)', () => {
  it('今天/昨天/更早日期', () => {
    expect(homeDayLabel('2026-10-03', '2026-10-03')).toBe('今天')
    expect(homeDayLabel('2026-10-02', '2026-10-03')).toBe('昨天')
    expect(homeDayLabel('2026-09-30', '2026-10-01')).toBe('昨天')
    expect(homeDayLabel('2026-09-20', '2026-10-03')).toBe('9月20日 周日')
  })
})

describe('categoryAccent(分类色块)', () => {
  it('父分类按排序取 chart 色板,未知分类回退 gray', () => {
    const ledger = fixtureLedger()
    expect(categoryAccent(ledger, LUNCH_CATEGORY)).toBe('var(--chart-1)')
    expect(categoryAccent(ledger, 'cat-housing-1')).toBe('var(--chart-4)')
    expect(categoryAccent(ledger, 'cat-missing')).toBe('var(--tag-gray)')
  })
})

describe('homeDonut(本月分类占比)', () => {
  it('聚合到父分类并按金额降序', () => {
    const ledger = ledgerWith([
      { amountCents: 100, date: '2026-10-03' },
      { amountCents: 300, date: '2026-10-03' },
    ])

    const slices = homeDonut(ledger, '2026-10')
    expect(slices).toHaveLength(1)
    expect(slices[0]?.id).toBe('cat-dining')
    expect(slices[0]?.totalCents).toBe(400)
    expect(slices[0]?.percent).toBe(100)
  })
})
