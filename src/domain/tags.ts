/**
 * 标签实体领域(ADR-0006):标签与标签组的 CRUD、组内选择规则与未分组合成。
 *
 * - 标签 id 由名字确定性派生(`tag-<sha256(name) 前 8 字节 hex>`),多设备各自
 *   迁移/新建同一名字会得到同一 id,合并即收敛;
 * - 标签的增/改/删对成员开放(删除会清理全部支出与标签组中的引用,不留悬挂);
 * - 标签组的增/改/删是管理员专属(组为共享元数据,成员端只拉,见 sync/engine);
 *   删除组只解散分组,绝不删除标签;
 * - 选择规则是纯函数 `applyTagSelection`:单选替换、多选切换、必选组不可清空最后一个。
 */
import type {
  Expense,
  LedgerData,
  Member,
  Tag,
  TagColor,
  TagGroup,
  TagGroupId,
  TagId,
} from './types'
import { DomainError } from './types'

/** 标签组/分类共用的 7 色词汇(ADR-0006) */
export const TAG_PALETTE: readonly TagColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
]

export function isTagColor(value: string): value is TagColor {
  return (TAG_PALETTE as readonly string[]).includes(value)
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * 名字 → 稳定标签 id:`tag-` + SHA-256(name) 前 8 字节的十六进制。
 * 同一名字在任何设备、任何时刻都派生出同一 id(crypto.subtle 在 workerd 与 Node 均可用)。
 */
export async function tagIdFromName(name: string): Promise<TagId> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))
  return `tag-${toHex(new Uint8Array(digest, 0, 8))}`
}

export function findTag(ledger: LedgerData, id: TagId): Tag {
  const tag = ledger.meta.tags.find((t) => t.id === id)
  if (!tag) throw new DomainError('unknown_tag', `标签不存在:${id}`)
  return tag
}

/**
 * 读取支出携带的标签 id。迁移完成前的旧记录可能没有 tagIds 字段,
 * 此时按空数组处理,保证读取路径不因历史数据崩溃。
 */
export function expenseTagIds(expense: Pick<Expense, 'tagIds'>): TagId[] {
  return Array.isArray(expense.tagIds) ? [...expense.tagIds] : []
}

function assertActive(member: Member): void {
  if (member.disabled) throw new DomainError('member_disabled', `成员已停用:${member.displayName}`)
}

function requireAdmin(actor: Member): void {
  if (actor.role !== 'admin') throw new DomainError('forbidden', '仅管理员可管理标签组')
}

function normalizeName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw new DomainError('invalid_name', '请输入标签名称')
  return name
}

/**
 * 新建标签(成员即可):名字去空白后派生 id;同名标签已存在时拒绝。
 * 返回创建出的实体,便于界面立即选中。
 */
export async function addTag(
  ledger: LedgerData,
  actor: Member,
  name: string,
  now: string,
): Promise<Tag> {
  assertActive(actor)
  const normalized = normalizeName(name)
  const id = await tagIdFromName(normalized)
  if (ledger.meta.tags.some((t) => t.id === id)) {
    throw new DomainError('tag_duplicated', `标签已存在:${normalized}`)
  }
  const tag: Tag = { id, name: normalized, updatedAt: now }
  ledger.meta.tags.push(tag)
  return tag
}

/**
 * 重命名标签(成员即可)。id 稳定,因此无需改动任何支出/标签组引用,
 * 仅刷新 updatedAt 让改名经 LWW 传播到其他设备。
 */
export function renameTag(
  ledger: LedgerData,
  actor: Member,
  id: TagId,
  name: string,
  now: string,
): LedgerData {
  assertActive(actor)
  const tag = findTag(ledger, id)
  const normalized = normalizeName(name)
  if (ledger.meta.tags.some((t) => t.id !== id && t.name === normalized)) {
    throw new DomainError('tag_duplicated', `标签已存在:${normalized}`)
  }
  const next: Tag = { ...tag, name: normalized, updatedAt: now }
  ledger.meta.tags = ledger.meta.tags.map((t) => (t.id === id ? next : t))
  return ledger
}

/**
 * 删除标签(成员即可):先移除实体,再清理所有支出 tagIds 与所有标签组 tagIds 中的引用,
 * 不留悬挂引用。被清理的支出刷新 updatedAt —— LWW 需要新时间戳才能把清理传播到其他设备
 * (与删除分类迁移支出的处理一致)。
 */
export function deleteTag(ledger: LedgerData, actor: Member, id: TagId, now: string): LedgerData {
  assertActive(actor)
  findTag(ledger, id)
  ledger.meta.tags = ledger.meta.tags.filter((t) => t.id !== id)

  for (const [month, data] of Object.entries(ledger.months)) {
    let changed = false
    const expenses = data.expenses.map((expense) => {
      const tagIds = expenseTagIds(expense)
      if (!tagIds.includes(id)) return expense
      changed = true
      return { ...expense, tagIds: tagIds.filter((tagId) => tagId !== id), updatedAt: now }
    })
    if (changed) ledger.months[month] = { expenses }
  }

  ledger.meta.tagGroups = ledger.meta.tagGroups.map((group) =>
    group.tagIds.includes(id)
      ? { ...group, tagIds: group.tagIds.filter((tagId) => tagId !== id) }
      : group,
  )
  return ledger
}

export interface TagGroupInput {
  id?: TagGroupId
  name: string
  color: TagColor
  tagIds?: TagId[]
  singleSelect?: boolean
  required?: boolean
}

function normalizeTagIds(ledger: LedgerData, tagIds: readonly TagId[] | undefined): TagId[] {
  const unique: TagId[] = []
  for (const id of tagIds ?? []) {
    findTag(ledger, id)
    if (!unique.includes(id)) unique.push(id)
  }
  return unique
}

function validatedGroup(ledger: LedgerData, group: TagGroup): TagGroup {
  if (!isTagColor(group.color)) {
    throw new DomainError('invalid_color', `不支持的标签组颜色:${group.color}`)
  }
  return {
    ...group,
    name: normalizeName(group.name),
    tagIds: normalizeTagIds(ledger, group.tagIds),
  }
}

/** 新建标签组(仅管理员);name 去空白,color 必须属于 7 色调色板,tagIds 必须存在并去重 */
export function addTagGroup(ledger: LedgerData, actor: Member, input: TagGroupInput): LedgerData {
  assertActive(actor)
  requireAdmin(actor)
  const group = validatedGroup(ledger, {
    id: input.id ?? `grp-${crypto.randomUUID()}`,
    name: input.name,
    color: input.color,
    tagIds: input.tagIds ?? [],
    singleSelect: input.singleSelect,
    required: input.required,
  })
  ledger.meta.tagGroups.push(group)
  return ledger
}

export interface TagGroupPatch {
  name?: string
  color?: TagColor
  tagIds?: TagId[]
  singleSelect?: boolean
  required?: boolean
}

/** 修改标签组(仅管理员):字段缺省表示不改动;tagIds 整体替换并校验存在性 */
export function updateTagGroup(
  ledger: LedgerData,
  actor: Member,
  id: TagGroupId,
  patch: TagGroupPatch,
): LedgerData {
  assertActive(actor)
  requireAdmin(actor)
  const group = ledger.meta.tagGroups.find((g) => g.id === id)
  if (!group) throw new DomainError('unknown_tag_group', `标签组不存在:${id}`)
  const next = validatedGroup(ledger, { ...group, ...patch })
  ledger.meta.tagGroups = ledger.meta.tagGroups.map((g) => (g.id === id ? next : g))
  return ledger
}

/** 删除标签组(仅管理员):只解散分组,标签实体与支出引用不受影响 */
export function deleteTagGroup(ledger: LedgerData, actor: Member, id: TagGroupId): LedgerData {
  assertActive(actor)
  requireAdmin(actor)
  if (!ledger.meta.tagGroups.some((g) => g.id === id)) {
    throw new DomainError('unknown_tag_group', `标签组不存在:${id}`)
  }
  ledger.meta.tagGroups = ledger.meta.tagGroups.filter((g) => g.id !== id)
  return ledger
}

/**
 * 组内点选(纯函数):返回更新后的完整选中列表(未参与本组选择的标签原样保留)。
 * - 单选组:选中新标签即替换本组旧选择;再次点击已选标签则取消(仅当组非必选);
 * - 多选组:切换点击的标签;
 * - 必选组:结果为空时返回原选择,保证「必选不可清空最后一个」;
 * - tagId 不属于该组时返回原选择不变。
 */
export function applyTagSelection(
  group: TagGroup,
  tagId: TagId,
  currentlySelectedIds: readonly TagId[],
): TagId[] {
  if (!group.tagIds.includes(tagId)) return [...currentlySelectedIds]
  const inGroup = new Set(group.tagIds)
  const outside = currentlySelectedIds.filter((id) => !inGroup.has(id))
  const selected = currentlySelectedIds.filter((id) => inGroup.has(id))

  const next = selected.includes(tagId)
    ? selected.filter((id) => id !== tagId)
    : group.singleSelect
      ? [tagId]
      : [...selected, tagId]

  if (group.required && next.length === 0) return [...currentlySelectedIds]
  return [...outside, ...next]
}

/**
 * 合成分组「未分组」:不属于任何标签组的标签,按 id 升序。
 * 它是展示用的合成分组,不是真实实体,不落库、不参与同步。
 */
export function synthesizeUngrouped(tags: readonly Tag[], groups: readonly TagGroup[]): Tag[] {
  const grouped = new Set<TagId>()
  for (const group of groups) {
    for (const id of group.tagIds) grouped.add(id)
  }
  return tags
    .filter((tag) => !grouped.has(tag.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
