import { describe, expect, it } from 'vitest'
import { addExpense } from './expenses'
import {
  ADMIN,
  DALI,
  fixtureLedger,
  LAOSAN,
  LUNCH_CATEGORY,
  NOW,
  nextId,
  XIAOHONG,
} from './fixtures'
import {
  addRecurring,
  canEditRecurring,
  dueDates,
  generateDueExpenses,
  nextDueDate,
  RECURRING_DEFAULT_NOTE,
  removeRecurring,
  updateRecurring,
} from './recurring'
import type { RecurringExpense } from './types'
import { DomainError } from './types'

function makeRule(patch: Partial<RecurringExpense> = {}): RecurringExpense {
  return {
    id: 'r-1',
    amountCents: 5000,
    categoryId: LUNCH_CATEGORY,
    tagNames: [],
    memberId: XIAOHONG.id,
    frequency: 'monthly',
    startDate: '2026-01-31',
    enabled: true,
    createdBy: XIAOHONG.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  }
}

describe('dueDates', () => {
  it('每日:含首尾,from 之前的期次不生成', () => {
    const rule = makeRule({ frequency: 'daily', startDate: '2026-10-01' })

    expect(dueDates(rule, '2026-10-01', '2026-10-05')).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ])
    expect(dueDates(rule, '2026-10-03', '2026-10-05')).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ])
    expect(
      dueDates(
        makeRule({ frequency: 'daily', startDate: '2026-11-01' }),
        '2026-10-25',
        '2026-10-30',
      ),
    ).toEqual([])
  })

  it('每周:跨月与跨年按 7 天步进,起点之前的区间为空', () => {
    const rule = makeRule({ frequency: 'weekly', startDate: '2026-09-28' }) // 周一

    expect(dueDates(rule, '2026-09-28', '2026-10-15')).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ])
    expect(dueDates(rule, '2026-10-06', '2026-10-19')).toEqual(['2026-10-12', '2026-10-19'])

    const newYear = makeRule({ frequency: 'weekly', startDate: '2025-12-29' })
    expect(dueDates(newYear, '2025-12-29', '2026-01-12')).toEqual([
      '2025-12-29',
      '2026-01-05',
      '2026-01-12',
    ])
  })

  it('每月 31 日:短月收敛到月末,长月回到 31 日', () => {
    const rule = makeRule({ frequency: 'monthly', startDate: '2026-01-31' })

    expect(dueDates(rule, '2026-01-01', '2026-05-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ])
  })

  it('每月 30 日:2 月收敛到 28/29 日', () => {
    const rule = makeRule({ frequency: 'monthly', startDate: '2026-01-30' })
    expect(dueDates(rule, '2026-02-01', '2026-03-31')).toEqual(['2026-02-28', '2026-03-30'])

    const leap = makeRule({ frequency: 'monthly', startDate: '2028-01-30' })
    expect(dueDates(leap, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29'])
  })

  it('每年 2 月 29 日:平年收敛到 2 月 28 日,闰年回到 29 日', () => {
    const rule = makeRule({ frequency: 'yearly', startDate: '2024-02-29' })

    expect(dueDates(rule, '2024-02-01', '2028-12-31')).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ])
  })

  it('年规则从年中开始;endDate 截断区间;from > to 返回空', () => {
    const rule = makeRule({ frequency: 'yearly', startDate: '2026-06-15', endDate: '2028-06-14' })
    expect(dueDates(rule, '2026-01-01', '2030-12-31')).toEqual(['2026-06-15', '2027-06-15'])

    const daily = makeRule({ frequency: 'daily', startDate: '2026-10-01', endDate: '2026-10-03' })
    expect(dueDates(daily, '2026-10-01', '2026-10-10')).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ])
    expect(dueDates(daily, '2026-10-05', '2026-10-01')).toEqual([])
  })
})

describe('nextDueDate', () => {
  it('返回不早于 from 的下一期;停用或无未来期次返回 undefined', () => {
    const monthly = makeRule({ frequency: 'monthly', startDate: '2026-01-31' })
    expect(nextDueDate(monthly, '2026-02-01')).toBe('2026-02-28')
    expect(nextDueDate(monthly, '2026-01-01')).toBe('2026-01-31')

    const yearly = makeRule({ frequency: 'yearly', startDate: '2024-02-29' })
    expect(nextDueDate(yearly, '2025-03-01')).toBe('2026-02-28')
    expect(nextDueDate(yearly, '2028-01-01')).toBe('2028-02-29')

    const ended = makeRule({ frequency: 'daily', startDate: '2026-01-01', endDate: '2026-01-05' })
    expect(nextDueDate(ended, '2026-02-01')).toBeUndefined()
    expect(nextDueDate(makeRule({ enabled: false }), '2026-01-01')).toBeUndefined()
  })
})

describe('generateDueExpenses', () => {
  it('按确定性 id 补记到期支出:note 默认、经手人与记录者取自规则', () => {
    const ledger = fixtureLedger()
    const rule = makeRule({
      id: 'r-rent',
      amountCents: 300000,
      frequency: 'monthly',
      startDate: '2026-08-31',
      memberId: ADMIN.id,
      createdBy: XIAOHONG.id,
      note: '房租',
      tagNames: ['转账'],
    })
    ledger.meta.recurring = [rule]

    const result = generateDueExpenses(ledger, '2026-10-02', NOW)

    expect(result.generated).toBe(2)
    expect(result.expenseIds).toEqual(['rec-r-rent-2026-08-31', 'rec-r-rent-2026-09-30'])
    const expense = ledger.months['2026-08']?.expenses[0]
    expect(expense).toMatchObject({
      id: 'rec-r-rent-2026-08-31',
      amountCents: 300000,
      memberId: ADMIN.id,
      recordedBy: XIAOHONG.id,
      note: '房租',
      tagNames: ['转账'],
    })

    const defaultNote = makeRule({ id: 'r-fixed', frequency: 'daily', startDate: '2026-10-01' })
    ledger.meta.recurring.push(defaultNote)
    generateDueExpenses(ledger, '2026-10-01', NOW)
    const generated = ledger.months['2026-10']?.expenses.find((item) =>
      item.id.startsWith('rec-r-fixed-'),
    )
    expect(generated?.note).toBe(RECURRING_DEFAULT_NOTE)
  })

  it('重复执行幂等:已存在同 id(含手工/其他设备生成)不再补记', () => {
    const ledger = fixtureLedger()
    ledger.meta.recurring = [makeRule({ frequency: 'daily', startDate: '2026-10-01' })]
    addExpense(
      ledger,
      { amountCents: 999, date: '2026-10-01', categoryId: LUNCH_CATEGORY, note: '已存在' },
      { actor: XIAOHONG, now: NOW, newId: 'rec-r-1-2026-10-01' },
    )

    const first = generateDueExpenses(ledger, '2026-10-03', NOW)
    expect(first.expenseIds).toEqual(['rec-r-1-2026-10-02', 'rec-r-1-2026-10-03'])

    const second = generateDueExpenses(ledger, '2026-10-03', NOW)
    expect(second.generated).toBe(0)
    expect(ledger.months['2026-10']?.expenses).toHaveLength(3)
  })

  it('跳过停用规则、分类缺失与成员停用;未来起始日不生成', () => {
    const ledger = fixtureLedger()
    ledger.meta.recurring = [
      makeRule({ id: 'r-off', frequency: 'daily', startDate: '2026-10-01', enabled: false }),
      makeRule({
        id: 'r-gone-cat',
        frequency: 'daily',
        startDate: '2026-10-01',
        categoryId: 'cat-gone',
      }),
      makeRule({
        id: 'r-disabled-member',
        frequency: 'daily',
        startDate: '2026-10-01',
        memberId: LAOSAN.id,
      }),
      makeRule({ id: 'r-future', frequency: 'daily', startDate: '2026-11-01' }),
    ]

    const result = generateDueExpenses(ledger, '2026-10-02', NOW)

    expect(result.generated).toBe(0)
    expect(Object.keys(ledger.months)).toEqual([])
  })

  it('修改规则只影响之后的期次:已生成的历史金额不变', () => {
    const ledger = fixtureLedger()
    ledger.meta.recurring = [
      makeRule({ id: 'r-sub', frequency: 'monthly', startDate: '2026-08-15' }),
    ]
    generateDueExpenses(ledger, '2026-09-15', NOW)

    updateRecurring(
      ledger,
      'r-sub',
      { amountCents: 8800 },
      { actor: XIAOHONG, now: '2026-10-01T00:00:00.000Z', newId: nextId('r') },
    )
    const result = generateDueExpenses(ledger, '2026-10-15', '2026-10-15T00:00:00.000Z')

    expect(result.expenseIds).toEqual(['rec-r-sub-2026-10-15'])
    expect(ledger.months['2026-08']?.expenses[0]?.amountCents).toBe(5000)
    expect(ledger.months['2026-09']?.expenses[0]?.amountCents).toBe(5000)
    expect(ledger.months['2026-10']?.expenses[0]?.amountCents).toBe(8800)
  })
})

describe('addRecurring / updateRecurring / removeRecurring', () => {
  it('创建:补默认值(createdBy=actor、enabled、标签拷贝)并做校验', () => {
    const ledger = fixtureLedger()
    addRecurring(
      ledger,
      {
        amountCents: 19900,
        categoryId: LUNCH_CATEGORY,
        frequency: 'monthly',
        startDate: '2026-10-01',
        note: '会员',
      },
      { actor: XIAOHONG, now: NOW, newId: 'r-new' },
    )
    expect(ledger.meta.recurring[0]).toMatchObject({
      id: 'r-new',
      memberId: XIAOHONG.id,
      createdBy: XIAOHONG.id,
      enabled: true,
      tagNames: [],
    })

    const bad = [
      { amountCents: 0 },
      { categoryId: 'cat-dining' },
      { categoryId: 'cat-none' },
      { memberId: LAOSAN.id },
      { frequency: 'hourly' as never },
      { startDate: '2026-02-30' },
      { startDate: '2026-10-10', endDate: '2026-10-01' },
    ]
    for (const patch of bad) {
      expect(() =>
        addRecurring(
          ledger,
          {
            amountCents: 100,
            categoryId: LUNCH_CATEGORY,
            frequency: 'monthly',
            startDate: '2026-10-01',
            ...patch,
          },
          { actor: XIAOHONG, now: NOW, newId: nextId('r') },
        ),
      ).toThrowError(DomainError)
    }
    expect(ledger.meta.recurring).toHaveLength(1)
  })

  it('停用的创建者不能新增规则', () => {
    const ledger = fixtureLedger()
    expect(() =>
      addRecurring(
        ledger,
        {
          amountCents: 100,
          categoryId: LUNCH_CATEGORY,
          frequency: 'weekly',
          startDate: '2026-10-01',
        },
        { actor: LAOSAN, now: NOW, newId: 'r-x' },
      ),
    ).toThrowError(/停用/)
  })

  it('维护权限:本人/管理员可改,他人被拒;停用后不再补记', () => {
    const ledger = fixtureLedger()
    addRecurring(
      ledger,
      { amountCents: 100, categoryId: LUNCH_CATEGORY, frequency: 'daily', startDate: '2026-10-01' },
      { actor: XIAOHONG, now: NOW, newId: 'r-mine' },
    )
    const mine = ledger.meta.recurring[0]
    if (!mine) throw new Error('fixture: 规则不存在')
    expect(canEditRecurring(XIAOHONG, mine)).toBe(true)
    expect(canEditRecurring(ADMIN, mine)).toBe(true)
    expect(canEditRecurring(DALI, mine)).toBe(false)

    expect(() =>
      updateRecurring(ledger, 'r-mine', { enabled: false }, { actor: DALI, now: NOW, newId: 'x' }),
    ).toThrowError(/只能修改/)
    updateRecurring(ledger, 'r-mine', { enabled: false }, { actor: ADMIN, now: NOW, newId: 'x' })
    expect(generateDueExpenses(ledger, '2026-10-05', NOW).generated).toBe(0)

    updateRecurring(
      ledger,
      'r-mine',
      { endDate: null, note: null },
      { actor: XIAOHONG, now: NOW, newId: 'x' },
    )
    expect(ledger.meta.recurring[0]?.endDate).toBeUndefined()
    expect(ledger.meta.recurring[0]?.note).toBeUndefined()
  })

  it('删除规则;他人删除被拒', () => {
    const ledger = fixtureLedger()
    addRecurring(
      ledger,
      {
        amountCents: 100,
        categoryId: LUNCH_CATEGORY,
        frequency: 'weekly',
        startDate: '2026-10-01',
      },
      { actor: XIAOHONG, now: NOW, newId: 'r-del' },
    )
    expect(() =>
      removeRecurring(ledger, 'r-del', { actor: DALI, now: NOW, newId: 'x' }),
    ).toThrowError(/只能修改/)
    removeRecurring(ledger, 'r-del', { actor: XIAOHONG, now: NOW, newId: 'x' })
    expect(ledger.meta.recurring).toEqual([])
    expect(() =>
      removeRecurring(ledger, 'r-del', { actor: XIAOHONG, now: NOW, newId: 'x' }),
    ).toThrowError(/不存在/)
  })
})
