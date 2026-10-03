/**
 * 标签迁移引擎(ADR-0006):v1 自由文本标签 → 标签实体。
 *
 * `migrateLegacyTagNames(ledger, now)` 扫描全部月份支出的废弃 `tagNames`:
 * 1. 每个名字经 `tagIdFromName` 派生确定性 id(去空白、去重);
 * 2. 与账本已有标签合并:同 id 保留既有实体(名字/时间戳不动),缺失的补建;
 * 3. 支出改写为 `tagIds` 并删除 `tagNames`(updatedAt 保持不变 —— 迁移是表示转换
 *    而非编辑,不得借新时间戳覆盖其他设备上的并发编辑);
 * 4. 第二遍运行找不到任何 `tagNames`,无任何变更(幂等、可安全重放)。
 *
 * 多设备并发迁移:确定性 id 保证各设备独立迁移出同一批标签实体;合并采用
 * 「按 id 并集 + updatedAt 后写胜出」,最终收敛到一致状态(测试见 tag-migration.test.ts
 * 与 sync/engine.test.ts)。
 */
import { expenseTagIds, tagIdFromName } from './tags'
import type { LedgerData, Tag, TagId } from './types'

export interface TagMigrationResult {
  /** 本次被改写(删除 tagNames、写入 tagIds)的支出数;第二遍为 0 */
  migratedExpenses: number
  /** 本次新建的标签实体数(已存在的同 id 标签不重复创建) */
  addedTags: number
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function uniqueSorted(ids: readonly TagId[]): TagId[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function migrateLegacyTagNames(
  ledger: LedgerData,
  now: string,
): Promise<TagMigrationResult> {
  let migratedExpenses = 0
  const known = new Set(ledger.meta.tags.map((tag) => tag.id))
  const created = new Map<TagId, Tag>()

  // 月份键排序后扫描,保证同一账本在不同设备上产生一致的实体集合与顺序
  for (const month of Object.keys(ledger.months).sort()) {
    const data = ledger.months[month]
    if (!data) continue
    for (const expense of data.expenses) {
      if (expense.tagNames === undefined) continue
      const derived: TagId[] = []
      const names = [...new Set(expense.tagNames.map((name) => name.trim()))]
      for (const name of names) {
        if (name === '') continue
        const id = await tagIdFromName(name)
        derived.push(id)
        if (!known.has(id) && !created.has(id)) {
          created.set(id, { id, name, updatedAt: now })
        }
      }
      expense.tagIds = uniqueSorted([...expenseTagIds(expense), ...derived])
      delete expense.tagNames
      migratedExpenses += 1
    }
  }

  const missing = [...created.values()].sort(byId)
  if (missing.length > 0) ledger.meta.tags = [...ledger.meta.tags, ...missing]
  return { migratedExpenses, addedTags: missing.length }
}
