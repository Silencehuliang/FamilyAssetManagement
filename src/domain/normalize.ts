/**
 * 账本形状规范化(向后兼容 v1 缓存,评审修复):把旧版(缺少标签字段)的
 * LedgerData 补全为当前形状,避免旧缓存直接进入同步引擎时抛 TypeError。
 *
 * v1 的 IndexedDB 缓存没有 `meta.tags` / `meta.tagGroups` 字段;若原样交给
 * `mergeTimestamped(local.meta.tags, …)`,`for … of undefined` 会抛
 * TypeError,SyncManager 把它当作网络失败吞成 offline —— 同步永远失败、
 * 迁移永远不运行。本函数补齐:
 * - meta 缺失的集合字段:members/categories/tags/tagGroups/recurring → 空数组,
 *   budgets → 空对象;meta 本身缺失时整体补空;
 * - months 缺失 → 空对象;月份条目的 expenses 缺失/非数组 → 空数组;
 * - 支出的 tagIds 缺失/非数组 → 空数组;废弃的 tagNames 原样保留,
 *   交给迁移引擎(src/domain/tag-migration.ts)转换成标签实体。
 *
 * 幂等:对当前形状的账本不做任何可观察改动;原地修改并返回同一对象,
 * 便于 boot 采纳缓存与同步合并两侧共用。
 */
import type { Expense, LedgerData, LedgerMeta } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function normalizeLedgerShape(ledger: LedgerData): LedgerData {
  const raw = ledger as unknown as { meta?: Partial<LedgerMeta> | null; months?: unknown }
  const meta: Partial<LedgerMeta> = isRecord(raw.meta) ? (raw.meta as Partial<LedgerMeta>) : {}
  meta.members = arrayOr<LedgerMeta['members'][number]>(meta.members)
  meta.categories = arrayOr<LedgerMeta['categories'][number]>(meta.categories)
  meta.tags = arrayOr<LedgerMeta['tags'][number]>(meta.tags)
  meta.tagGroups = arrayOr<LedgerMeta['tagGroups'][number]>(meta.tagGroups)
  meta.budgets = isRecord(meta.budgets) ? (meta.budgets as LedgerMeta['budgets']) : {}
  meta.recurring = arrayOr<LedgerMeta['recurring'][number]>(meta.recurring)
  ledger.meta = meta as LedgerMeta

  const months: Record<string, unknown> = isRecord(ledger.months) ? ledger.months : {}
  for (const [month, data] of Object.entries(months)) {
    const expenses = isRecord(data) ? arrayOr<Expense>(data.expenses) : []
    for (const expense of expenses) {
      if (!Array.isArray(expense.tagIds)) expense.tagIds = []
    }
    months[month] = { expenses }
  }
  ledger.months = months as LedgerData['months']
  return ledger
}
