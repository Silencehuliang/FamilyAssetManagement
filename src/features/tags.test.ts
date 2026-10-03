import { describe, expect, it } from 'vitest'
import { addExpense, type LedgerData, type TagGroup } from '../domain'
import { ADMIN, fixtureLedger, NOW, XIAOHONG } from '../domain/fixtures'
import {
  moveGroupId,
  moveItem,
  resolveExpenseTagNames,
  sortedTagGroups,
  TAG_CHIP_ACTIVE_CLASS,
  TAG_CHIP_CLASS,
  TAG_DOT_CLASS,
  TAG_PALETTE,
  TAG_SWATCH_ACTIVE_CLASS,
  tagManagerSections,
  tagUsageCount,
} from './tags'

function ledgerWithTags(): LedgerData {
  const ledger = fixtureLedger()
  ledger.meta.tags = [
    { id: 'tag-a', name: '微信', updatedAt: NOW },
    { id: 'tag-b', name: '现金', updatedAt: NOW },
    { id: 'tag-c', name: '旅行', updatedAt: NOW },
  ]
  ledger.meta.tagGroups = [
    {
      id: 'g-1',
      name: '支付方式',
      color: 'blue',
      tagIds: ['tag-a', 'tag-unknown'],
      singleSelect: true,
      required: true,
      sortOrder: 1,
    },
    { id: 'g-2', name: '场景', color: 'green', tagIds: ['tag-c'], sortOrder: 0 },
  ]
  return ledger
}

function addTaggedExpense(ledger: LedgerData, tagIds: string[], id: string): void {
  addExpense(
    ledger,
    { amountCents: 1000, date: '2026-10-02', categoryId: 'cat-dining-2', tagIds },
    { actor: XIAOHONG, now: NOW, newId: id },
  )
}

describe('tagUsageCount(删除引用计数)', () => {
  it('统计引用该标签的支出笔数,跨月份累计;不存在引用为 0', () => {
    const ledger = ledgerWithTags()
    addTaggedExpense(ledger, ['tag-a', 'tag-b'], 'e-1')
    addTaggedExpense(ledger, ['tag-a'], 'e-2')
    addExpense(
      ledger,
      { amountCents: 500, date: '2026-11-03', categoryId: 'cat-dining-2', tagIds: ['tag-a'] },
      { actor: XIAOHONG, now: NOW, newId: 'e-3' },
    )

    expect(tagUsageCount(ledger, 'tag-a')).toBe(3)
    expect(tagUsageCount(ledger, 'tag-b')).toBe(1)
    expect(tagUsageCount(ledger, 'tag-c')).toBe(0)
  })

  it('迁移完成前的旧记录(tagIds 缺失)按空引用处理', () => {
    const ledger = fixtureLedger()
    ledger.months = {
      '2026-10': {
        expenses: [
          {
            id: 'e-legacy',
            amountCents: 100,
            date: '2026-10-02',
            categoryId: 'cat-dining-2',
            memberId: ADMIN.id,
            recordedBy: ADMIN.id,
            createdAt: NOW,
            updatedAt: NOW,
          } as never,
        ],
      },
    }

    expect(tagUsageCount(ledger, 'tag-a')).toBe(0)
  })
})

describe('resolveExpenseTagNames(读路径)', () => {
  it('按 tagIds 解析实体名字,未知 id 过滤;旧记录回退 tagNames', () => {
    const ledger = ledgerWithTags()
    addTaggedExpense(ledger, ['tag-a'], 'e-1')
    const migrated = ledger.months['2026-10']?.expenses[0]
    if (!migrated) throw new Error('fixture: 支出缺失')
    const withDangling = { ...migrated, tagIds: [...migrated.tagIds, 'tag-missing'] }

    expect(resolveExpenseTagNames(ledger, withDangling)).toEqual(['微信'])
    expect(
      resolveExpenseTagNames(ledger, { ...migrated, tagIds: [], tagNames: ['旧标签'] }),
    ).toEqual(['旧标签'])
  })
})

describe('tagManagerSections(管理界面分区)', () => {
  it('未分组按 id 升序;各组按 sortOrder,组内按 tagIds 顺序且过滤未知引用', () => {
    const ledger = ledgerWithTags()
    const sections = tagManagerSections(ledger)

    expect(sections.ungrouped.map((tag) => tag.id)).toEqual(['tag-b'])
    expect(sections.groups.map((section) => section.group.id)).toEqual(['g-2', 'g-1'])
    expect(sections.groups[1]?.tags.map((tag) => tag.id)).toEqual(['tag-a'])
  })
})

describe('sortedTagGroups(展示排序)', () => {
  it('sortOrder 升序;缺省(旧数据)保持数组原序排在末尾;不改动原数组', () => {
    const groups: TagGroup[] = [
      { id: 'g-a', name: '甲', color: 'blue', tagIds: [] },
      { id: 'g-b', name: '乙', color: 'red', tagIds: [], sortOrder: 5 },
      { id: 'g-c', name: '丙', color: 'gray', tagIds: [], sortOrder: 1 },
    ]

    expect(sortedTagGroups(groups).map((group) => group.id)).toEqual(['g-c', 'g-b', 'g-a'])
    expect(groups.map((group) => group.id)).toEqual(['g-a', 'g-b', 'g-c'])
  })
})

describe('moveItem / moveGroupId(排序按钮)', () => {
  it('上/下移一项;越界返回原序拷贝', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 9, 1)).toEqual(['a', 'b', 'c'])
  })

  it('moveGroupId 按 id 定位;未知 id 返回原序拷贝', () => {
    expect(moveGroupId(['g-1', 'g-2', 'g-3'], 'g-3', -1)).toEqual(['g-1', 'g-3', 'g-2'])
    expect(moveGroupId(['g-1', 'g-2'], 'g-x', 1)).toEqual(['g-1', 'g-2'])
  })
})

describe('颜色令牌映射', () => {
  it('7 色全部有 chip(常态/选中)、圆点、swatch 外圈类名;类名为静态字面量', () => {
    for (const color of TAG_PALETTE) {
      expect(TAG_CHIP_CLASS[color]).toContain(`tag-${color}`)
      expect(TAG_CHIP_ACTIVE_CLASS[color]).toContain(`bg-tag-${color}`)
      expect(TAG_DOT_CLASS[color]).toBe(`bg-tag-${color}`)
      expect(TAG_SWATCH_ACTIVE_CLASS[color]).toBe(`ring-tag-${color}`)
    }
  })
})
