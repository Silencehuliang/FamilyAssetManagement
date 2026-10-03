import { describe, expect, it } from 'vitest'
import { addExpense, type LedgerData, type TagGroup } from '../domain'
import { fixtureLedger, NOW, XIAOHONG } from '../domain/fixtures'
import {
  buildEditorExpenseInput,
  buildEditorExpensePatch,
  defaultChildId,
  draftForAgain,
  draftForNew,
  draftFromExpense,
  initialTagSelection,
  selectParentCategory,
  toggleTagSelection,
} from './editor'
import { display, type FormulaKey, pressKey } from './formula'

function typeFormula(keys: string, draft: ReturnType<typeof draftForNew>) {
  return keys.split('').reduce((state, key) => pressKey(state, key as FormulaKey), draft.formula)
}

function ledgerWithTags(): LedgerData {
  const ledger = fixtureLedger()
  ledger.meta.tags = [
    { id: 'tag-a', name: '微信', updatedAt: NOW },
    { id: 'tag-b', name: '现金', updatedAt: NOW },
    { id: 'tag-c', name: '旅行', updatedAt: NOW },
  ]
  ledger.meta.tagGroups = [
    {
      id: 'g-pay',
      name: '支付方式',
      color: 'blue',
      tagIds: ['tag-a', 'tag-b'],
      singleSelect: true,
      required: true,
    },
    { id: 'g-empty', name: '空组', color: 'red', tagIds: [], required: true },
    { id: 'g-scene', name: '场景', color: 'green', tagIds: ['tag-c'] },
  ]
  return ledger
}

const groupOf = (groups: readonly TagGroup[], id: string): TagGroup => {
  const group = groups.find((item) => item.id === id)
  if (!group) throw new Error(`fixture: 组 ${id} 不存在`)
  return group
}

describe('initialTagSelection(必选组自动选中第一个)', () => {
  it('每个必选组选第一个标签;空必选组自动失效;跨组去重', () => {
    const ledger = ledgerWithTags()
    const groups = ledger.meta.tagGroups
    expect(initialTagSelection(groups)).toEqual(['tag-a'])

    ledger.meta.tagGroups = [
      { id: 'g-1', name: '一', color: 'blue', tagIds: ['tag-a', 'tag-b'], required: true },
      { id: 'g-2', name: '二', color: 'green', tagIds: ['tag-c'], required: true },
      { id: 'g-3', name: '三', color: 'red', tagIds: ['tag-b'], singleSelect: true },
    ]
    expect(initialTagSelection(ledger.meta.tagGroups)).toEqual(['tag-a', 'tag-c'])
    expect(initialTagSelection([])).toEqual([])
  })
})

describe('toggleTagSelection(组内点选接线)', () => {
  it('单选组点选替换;必选组不可清空最后一个;可切换到其他标签', () => {
    const { meta } = ledgerWithTags()
    const pay = groupOf(meta.tagGroups, 'g-pay')

    expect(toggleTagSelection(pay, 'tag-b', ['tag-a'])).toEqual(['tag-b'])
    expect(toggleTagSelection(pay, 'tag-a', ['tag-a'])).toEqual(['tag-a'])
    // 必选 + 单选:再点已选标签保持原选择(不可清空最后一个)
    expect(toggleTagSelection(pay, 'tag-b', ['tag-b'])).toEqual(['tag-b'])
  })

  it('多选组切换选中;未分组行(null)普通切换', () => {
    const { meta } = ledgerWithTags()
    const scene = groupOf(meta.tagGroups, 'g-scene')

    expect(toggleTagSelection(scene, 'tag-c', [])).toEqual(['tag-c'])
    expect(toggleTagSelection(scene, 'tag-c', ['tag-c'])).toEqual([])
    expect(toggleTagSelection(null, 'tag-a', [])).toEqual(['tag-a'])
    expect(toggleTagSelection(null, 'tag-a', ['tag-a', 'tag-b'])).toEqual(['tag-b'])
  })

  it('tagId 不属于该组时保持原选择', () => {
    const { meta } = ledgerWithTags()
    const scene = groupOf(meta.tagGroups, 'g-scene')
    expect(toggleTagSelection(scene, 'tag-a', ['tag-c'])).toEqual(['tag-c'])
  })
})

describe('分类父子点选语义', () => {
  it('defaultChildId:父分类第一个子分类(按 sortOrder);无子分类返回空', () => {
    const ledger = fixtureLedger()
    expect(defaultChildId(ledger, 'cat-dining')).toBe('cat-dining-1')
    expect(defaultChildId(ledger, 'cat-transport')).toBe('cat-transport-1')
    expect(defaultChildId(ledger, 'cat-missing')).toBe('')
  })

  it('点父分类:当前选中属于其子时保持,否则选第一个子分类', () => {
    const ledger = fixtureLedger()
    expect(selectParentCategory(ledger, 'cat-dining-2', 'cat-dining')).toBe('cat-dining-2')
    expect(selectParentCategory(ledger, 'cat-dining-2', 'cat-transport')).toBe('cat-transport-1')
    expect(selectParentCategory(ledger, '', 'cat-housing')).toBe('cat-housing-1')
  })

  it('账本无分类时用默认分类兜底(离线首启可立即记账)', () => {
    const ledger = fixtureLedger()
    ledger.meta.categories = []
    expect(defaultChildId(ledger, 'cat-dining')).toBe('cat-dining-1')
  })
})

describe('draftForNew / draftForAgain(新单与再记)', () => {
  it('新单:金额空、默认父/子分类、日期取今天、必选标签自动选中', () => {
    const ledger = ledgerWithTags()
    const draft = draftForNew(ledger, XIAOHONG.id, '2026-10-03')

    expect(display(draft.formula)).toBe('')
    expect(draft.parentId).toBe('cat-dining')
    expect(draft.categoryId).toBe('cat-dining-1')
    expect(draft.date).toBe('2026-10-03')
    expect(draft.note).toBe('')
    expect(draft.tagIds).toEqual(['tag-a'])
    expect(draft.memberId).toBe(XIAOHONG.id)
  })

  it('再记:仅保留日期(金额归零、分类回默认、必选标签按规则重新选中)', () => {
    const ledger = ledgerWithTags()
    const draft = draftForAgain(ledger, XIAOHONG.id, '2026-10-02')

    expect(display(draft.formula)).toBe('')
    expect(draft.tagIds).toEqual(['tag-a'])
    expect(draft.date).toBe('2026-10-02')
    expect(draft.categoryId).toBe('cat-dining-1')
  })
})

describe('draftFromExpense(编辑预填)', () => {
  it('金额折叠、分类父/子、标签过滤未知引用、备注与经手人回填', () => {
    const ledger = ledgerWithTags()
    addExpense(
      ledger,
      {
        amountCents: 1234,
        date: '2026-10-02',
        categoryId: 'cat-dining-2',
        tagIds: ['tag-a'],
        note: '午饭',
        memberId: XIAOHONG.id,
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )
    const expense = ledger.months['2026-10']?.expenses[0]
    if (!expense) throw new Error('fixture: 支出缺失')
    expense.tagIds = [...expense.tagIds, 'tag-missing']

    const draft = draftFromExpense(ledger, expense, XIAOHONG.id)

    expect(display(draft.formula)).toBe('12.34')
    expect(draft.parentId).toBe('cat-dining')
    expect(draft.categoryId).toBe('cat-dining-2')
    expect(draft.date).toBe('2026-10-02')
    expect(draft.note).toBe('午饭')
    expect(draft.tagIds).toEqual(['tag-a'])
    expect(draft.memberId).toBe(XIAOHONG.id)
  })
})

describe('buildEditorExpenseInput / Patch(草稿 → 领域输入)', () => {
  it('公式求值换算金额、去重标签、备注去空白、经手人空串回落本人', () => {
    const ledger = ledgerWithTags()
    const base = draftForNew(ledger, '', '2026-10-02')
    const draft = {
      ...base,
      formula: typeFormula('12+3', base),
      note: ' 午饭 ',
      tagIds: ['tag-a', 'tag-a', 'tag-b'],
    }

    const input = buildEditorExpenseInput(ledger, draft)
    expect(input).toEqual({
      amountCents: 1500,
      date: '2026-10-02',
      categoryId: 'cat-dining-1',
      tagIds: ['tag-a', 'tag-b'],
      memberId: undefined,
      note: '午饭',
    })

    const patch = buildEditorExpensePatch(ledger, { ...draft, note: '' })
    expect(patch.note).toBeNull()
    expect(patch.memberId).toBeUndefined()
    expect(patch.amountCents).toBe(1500)
  })

  it('金额为 0/非法日期/未选子分类被拒(可读文案)', () => {
    const ledger = ledgerWithTags()
    const base = draftForNew(ledger, XIAOHONG.id, '2026-10-02')
    const amount = typeFormula('5', base)

    expect(() => buildEditorExpenseInput(ledger, base)).toThrowError(/大于 0/)
    expect(() =>
      buildEditorExpenseInput(ledger, { ...base, formula: amount, date: '10/02' }),
    ).toThrowError(/日期/)
    expect(() =>
      buildEditorExpenseInput(ledger, { ...base, formula: amount, categoryId: 'cat-dining' }),
    ).toThrowError(/子分类/)
    expect(() =>
      buildEditorExpenseInput(ledger, { ...base, formula: amount, categoryId: 'nope' }),
    ).toThrowError(/分类/)
  })
})
