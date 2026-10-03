import { describe, expect, it } from 'vitest'
import { addExpense } from './expenses'
import {
  ADMIN,
  DINNER_CATEGORY,
  fixtureLedger,
  LAOSAN,
  LUNCH_CATEGORY,
  NOW,
  XIAOHONG,
} from './fixtures'
import {
  addTag,
  addTagGroup,
  applyTagSelection,
  deleteTag,
  deleteTagGroup,
  findTag,
  isTagColor,
  renameTag,
  synthesizeUngrouped,
  TAG_PALETTE,
  tagIdFromName,
  updateTagGroup,
  upsertTagsByName,
} from './tags'
import type { LedgerData, TagColor, TagGroup } from './types'

function ledgerWithExpense(
  tagIds: string[],
  options: { id?: string; date?: string; categoryId?: string } = {},
): LedgerData {
  const ledger = fixtureLedger()
  addExpense(
    ledger,
    {
      amountCents: 1200,
      date: options.date ?? '2026-10-02',
      categoryId: options.categoryId ?? LUNCH_CATEGORY,
      tagIds,
    },
    { actor: XIAOHONG, now: NOW, newId: options.id ?? 'e-1' },
  )
  return ledger
}

function groupOf(overrides: Partial<TagGroup> = {}): TagGroup {
  return { id: 'g-1', name: '支付方式', color: 'blue', tagIds: ['t-a', 't-b', 't-c'], ...overrides }
}

describe('tagIdFromName(确定性 id)', () => {
  it('id = tag- + SHA-256(name) 前 8 字节 hex(固定测试向量)', async () => {
    await expect(tagIdFromName('微信')).resolves.toBe('tag-81b430b696435180')
    await expect(tagIdFromName('现金')).resolves.toBe('tag-118f18e6840546c1')
    await expect(tagIdFromName('日用')).resolves.toBe('tag-a7f67b4983d970db')
  })

  it('同名恒定、异名不同,且格式稳定', async () => {
    const first = await tagIdFromName('旅行')
    const second = await tagIdFromName('旅行')
    expect(first).toBe(second)
    expect(first).toMatch(/^tag-[0-9a-f]{16}$/)
    expect(await tagIdFromName('旅行 ')).not.toBe(first) // 不做隐式 trim,派生是名字的纯函数
  })
})

describe('upsertTagsByName(旧编辑器兼容写路径,评审修复)', () => {
  it('补建缺失实体:确定性 id、名字去空白、输入去重、顺序保持', async () => {
    const ledger = fixtureLedger()

    const tags = await upsertTagsByName(ledger, [' 微信 ', '现金', '微信'], NOW)

    expect(tags).toEqual([
      { id: await tagIdFromName('微信'), name: '微信', updatedAt: NOW },
      { id: await tagIdFromName('现金'), name: '现金', updatedAt: NOW },
    ])
    expect(ledger.meta.tags).toEqual(tags)
  })

  it('已有实体保持原样(名字/updatedAt 不被覆盖);空名忽略', async () => {
    const ledger = fixtureLedger()
    const existing = {
      id: await tagIdFromName('微信'),
      name: '微信(旧名)',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    ledger.meta.tags = [existing]

    const tags = await upsertTagsByName(ledger, ['微信', '', '  '], NOW)

    expect(tags).toEqual([existing])
    expect(ledger.meta.tags).toEqual([existing])
  })
})

describe('标签实体 CRUD(成员即可)', () => {
  it('addTag:去空白、由名字派生 id;普通成员可建', async () => {
    const ledger = fixtureLedger()
    const tag = await addTag(ledger, XIAOHONG, '  微信  ', NOW)
    expect(tag).toEqual({ id: await tagIdFromName('微信'), name: '微信', updatedAt: NOW })
    expect(ledger.meta.tags).toEqual([tag])
  })

  it('addTag:同名重复与空名被拒;停用成员被拒', async () => {
    const ledger = fixtureLedger()
    await addTag(ledger, ADMIN, '微信', NOW)
    await expect(addTag(ledger, XIAOHONG, ' 微信 ', NOW)).rejects.toMatchObject({
      code: 'tag_duplicated',
    })
    await expect(addTag(ledger, XIAOHONG, '   ', NOW)).rejects.toMatchObject({
      code: 'invalid_name',
    })
    await expect(addTag(ledger, LAOSAN, '现金', NOW)).rejects.toMatchObject({
      code: 'member_disabled',
    })
    expect(ledger.meta.tags).toHaveLength(1)
  })

  it('renameTag:id 稳定、所有引用不动、updatedAt 刷新', async () => {
    const ledger = fixtureLedger()
    const tag = await addTag(ledger, ADMIN, '微信', NOW)
    addExpense(
      ledger,
      { amountCents: 100, date: '2026-10-02', categoryId: LUNCH_CATEGORY, tagIds: [tag.id] },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )
    addTagGroup(ledger, ADMIN, { id: 'g-1', name: '支付方式', color: 'blue', tagIds: [tag.id] })

    renameTag(ledger, XIAOHONG, tag.id, '微信支付', '2026-11-01T00:00:00.000Z')

    expect(findTag(ledger, tag.id)).toEqual({
      id: tag.id,
      name: '微信支付',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    expect(ledger.months['2026-10']?.expenses[0]?.tagIds).toEqual([tag.id])
    expect(ledger.meta.tagGroups[0]?.tagIds).toEqual([tag.id])
  })

  it('renameTag:改名撞上其他标签名被拒,未知 id 报 unknown_tag', async () => {
    const ledger = fixtureLedger()
    const wx = await addTag(ledger, ADMIN, '微信', NOW)
    await addTag(ledger, ADMIN, '现金', NOW)
    expect(() => renameTag(ledger, ADMIN, wx.id, '现金', NOW)).toThrowError(/标签已存在/)
    expect(() => renameTag(ledger, ADMIN, 'tag-missing', 'x', NOW)).toThrowError(/标签不存在/)
  })

  it('deleteTag:清理全部支出的 tagIds 与所有标签组的 tagIds,无悬挂引用', async () => {
    const ledger = fixtureLedger()
    const wx = await addTag(ledger, ADMIN, '微信', NOW)
    const cash = await addTag(ledger, ADMIN, '现金', NOW)
    addExpense(
      ledger,
      {
        amountCents: 100,
        date: '2026-10-02',
        categoryId: LUNCH_CATEGORY,
        tagIds: [wx.id, cash.id],
      },
      { actor: XIAOHONG, now: NOW, newId: 'e-1' },
    )
    addExpense(
      ledger,
      { amountCents: 200, date: '2026-09-30', categoryId: DINNER_CATEGORY, tagIds: [wx.id] },
      { actor: XIAOHONG, now: NOW, newId: 'e-2' },
    )
    addExpense(
      ledger,
      { amountCents: 300, date: '2026-10-03', categoryId: DINNER_CATEGORY, tagIds: [cash.id] },
      { actor: XIAOHONG, now: NOW, newId: 'e-3' },
    )
    addTagGroup(ledger, ADMIN, {
      id: 'g-1',
      name: '支付方式',
      color: 'blue',
      tagIds: [wx.id, cash.id],
      singleSelect: true,
    })

    deleteTag(ledger, XIAOHONG, wx.id, '2026-11-01T00:00:00.000Z')

    expect(ledger.meta.tags.map((t) => t.id)).toEqual([cash.id])
    expect(ledger.meta.tagGroups[0]?.tagIds).toEqual([cash.id])
    const byId = new Map(
      Object.values(ledger.months)
        .flatMap((m) => m.expenses)
        .map((e) => [e.id, e]),
    )
    expect(byId.get('e-1')?.tagIds).toEqual([cash.id])
    expect(byId.get('e-2')?.tagIds).toEqual([])
    expect(byId.get('e-3')?.tagIds).toEqual([cash.id])
    // 受清理影响的两笔刷新 updatedAt(LWW 传播用),未受影响的保持原时间戳
    expect(byId.get('e-1')?.updatedAt).toBe('2026-11-01T00:00:00.000Z')
    expect(byId.get('e-2')?.updatedAt).toBe('2026-11-01T00:00:00.000Z')
    expect(byId.get('e-3')?.updatedAt).toBe(NOW)
  })

  it('deleteTag:未知 id 报 unknown_tag', async () => {
    const ledger = fixtureLedger()
    expect(() => deleteTag(ledger, XIAOHONG, 'tag-missing', NOW)).toThrowError(/标签不存在/)
  })
})

describe('标签组 CRUD(管理员门禁)', () => {
  it('普通成员增/改/删组一律 forbidden', async () => {
    const ledger = fixtureLedger()
    const tag = await addTag(ledger, ADMIN, '微信', NOW)
    expect(() =>
      addTagGroup(ledger, XIAOHONG, { name: '支付方式', color: 'blue', tagIds: [tag.id] }),
    ).toThrowError(/仅管理员/)
    expect(ledger.meta.tagGroups).toEqual([])
  })

  it('addTagGroup:name 去空白、tagIds 校验存在并去重、支持单选/必选', async () => {
    const ledger = fixtureLedger()
    const wx = await addTag(ledger, ADMIN, '微信', NOW)
    const cash = await addTag(ledger, ADMIN, '现金', NOW)
    addTagGroup(ledger, ADMIN, {
      id: 'g-1',
      name: ' 支付方式 ',
      color: 'blue',
      tagIds: [wx.id, wx.id, cash.id],
      singleSelect: true,
      required: true,
    })
    expect(ledger.meta.tagGroups).toEqual([
      {
        id: 'g-1',
        name: '支付方式',
        color: 'blue',
        tagIds: [wx.id, cash.id],
        singleSelect: true,
        required: true,
      },
    ])
    // 生成 id 时带 grp- 前缀
    addTagGroup(ledger, ADMIN, { name: '场景', color: 'green' })
    expect(ledger.meta.tagGroups[1]?.id).toMatch(/^grp-/)
  })

  it('addTagGroup:非法颜色/不存在的标签被拒', async () => {
    const ledger = fixtureLedger()
    expect(() =>
      addTagGroup(ledger, ADMIN, {
        name: '组',
        color: 'pink' as unknown as TagColor,
        tagIds: [],
      }),
    ).toThrowError(/颜色/)
    expect(() =>
      addTagGroup(ledger, ADMIN, { name: '组', color: 'red', tagIds: ['tag-missing'] }),
    ).toThrowError(/标签不存在/)
    expect(ledger.meta.tagGroups).toEqual([])
  })

  it('updateTagGroup:整体替换字段并校验;未知组报 unknown_tag_group', async () => {
    const ledger = fixtureLedger()
    const wx = await addTag(ledger, ADMIN, '微信', NOW)
    const cash = await addTag(ledger, ADMIN, '现金', NOW)
    addTagGroup(ledger, ADMIN, { id: 'g-1', name: '支付方式', color: 'blue', tagIds: [wx.id] })

    updateTagGroup(ledger, ADMIN, 'g-1', { name: '付款', color: 'purple', tagIds: [cash.id] })
    expect(ledger.meta.tagGroups[0]).toEqual({
      id: 'g-1',
      name: '付款',
      color: 'purple',
      tagIds: [cash.id],
    })
    expect(() => updateTagGroup(ledger, ADMIN, 'g-missing', { name: 'x' })).toThrowError(
      /标签组不存在/,
    )
  })

  it('deleteTagGroup:只解散分组,标签实体与支出引用不受影响', async () => {
    const ledger = ledgerWithExpense([])
    const tag = await addTag(ledger, ADMIN, '微信', NOW)
    const expense = ledger.months['2026-10']?.expenses[0]
    if (!expense) throw new Error('fixture: 支出缺失')
    expense.tagIds = [tag.id]
    addTagGroup(ledger, ADMIN, { id: 'g-1', name: '支付方式', color: 'blue', tagIds: [tag.id] })

    deleteTagGroup(ledger, ADMIN, 'g-1')

    expect(ledger.meta.tagGroups).toEqual([])
    expect(ledger.meta.tags).toEqual([tag])
    expect(expense.tagIds).toEqual([tag.id])
    expect(() => deleteTagGroup(ledger, ADMIN, 'g-1')).toThrowError(/标签组不存在/)
  })
})

describe('applyTagSelection(组内选择规则)', () => {
  const a = 't-a'
  const b = 't-b'

  it('多选组:切换选中;组外标签原样保留', () => {
    const group = groupOf()
    expect(applyTagSelection(group, b, ['x', a])).toEqual(['x', a, b])
    expect(applyTagSelection(group, a, ['x', a, b])).toEqual(['x', b])
    expect(applyTagSelection(group, 't-c', ['x'])).toEqual(['x', 't-c'])
  })

  it('单选组:选中新标签替换本组旧选择;组外保留', () => {
    const group = groupOf({ singleSelect: true })
    expect(applyTagSelection(group, b, ['x', a])).toEqual(['x', b])
    expect(applyTagSelection(group, a, ['x'])).toEqual(['x', a])
  })

  it('单选组:再次点击已选标签取消选择(组非必选)', () => {
    const group = groupOf({ singleSelect: true })
    expect(applyTagSelection(group, a, ['x', a])).toEqual(['x'])
  })

  it('必选组:不可清空最后一个;仍可切换到其他标签或移除多余选择', () => {
    const single = groupOf({ singleSelect: true, required: true })
    expect(applyTagSelection(single, a, ['x', a])).toEqual(['x', a])
    expect(applyTagSelection(single, b, ['x', a])).toEqual(['x', b])

    const multi = groupOf({ required: true })
    expect(applyTagSelection(multi, a, ['x', a])).toEqual(['x', a]) // 最后一个不可移除
    expect(applyTagSelection(multi, a, ['x', a, b])).toEqual(['x', b]) // 还有别的选中时可以移除
  })

  it('tagId 不属于该组时返回原选择不变', () => {
    const group = groupOf()
    expect(applyTagSelection(group, 't-foreign', ['x', a])).toEqual(['x', a])
  })
})

describe('synthesizeUngrouped(合成分组)', () => {
  it('返回不属于任何组的标签,按 id 升序;跨组去重', async () => {
    const tags = [
      { id: 'tag-b', name: '乙', updatedAt: NOW },
      { id: 'tag-a', name: '甲', updatedAt: NOW },
      { id: 'tag-c', name: '丙', updatedAt: NOW },
      { id: 'tag-d', name: '丁', updatedAt: NOW },
    ]
    const groups: TagGroup[] = [
      { id: 'g-1', name: '组一', color: 'blue', tagIds: ['tag-c'] },
      { id: 'g-2', name: '组二', color: 'red', tagIds: ['tag-d', 'tag-c'] },
    ]
    expect(synthesizeUngrouped(tags, groups).map((t) => t.id)).toEqual(['tag-a', 'tag-b'])
    expect(synthesizeUngrouped(tags, [])).toHaveLength(4)
  })
})

describe('调色板', () => {
  it('7 色固定词汇,校验函数与之一致', () => {
    expect(TAG_PALETTE).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'])
    expect(isTagColor('blue')).toBe(true)
    expect(isTagColor('pink')).toBe(false)
  })
})
