import type {
  Budget,
  Category,
  Expense,
  LedgerData,
  Member,
  MonthKey,
  Tag,
  TagGroup,
} from '../domain'
import type { RemoteFile, SyncEndpoint } from './endpoint'
import {
  BUDGETS_FILE,
  CATEGORIES_FILE,
  filesToLedger,
  isLedgerFilePath,
  ledgerToFiles,
  TAG_GROUPS_FILE,
} from './files'

/**
 * 同步引擎:一轮「拉取 → 记录级合并 → 增量推送」(ADR-0004)。
 *
 * 合并规则(v1.1):
 * - 支出与周期支出:按 id 取并集;双方都有时按 updatedAt 后写胜出(LWW)。
 *   同一时刻(updatedAt 相同)而内容不同时,取 JSON 序列化后字典序更大的一方——
 *   该规则与「谁是本地、谁是远端」无关,保证多端在同刻冲突下收敛到同一结果。
 * - 成员:远端只补本地缺失的 id,双方都有时保留本地。
 * - 标签(ADR-0006):双方均可写,按 id 并集、updatedAt 后写胜出(LWW);标签删除
 *   由领域层清理引用(支出引用经 updatedAt 传播);并集合并本身不表达「实体删除」。
 * - 分类:默认远端只补缺、双方都有保留本地;adminFilesPolicy='remote-wins' 时
 *   采用远端文件(成员端采纳管理员改动,不用旧副本回推)。
 * - 标签组:同分类走 adminFilesPolicy(成员端 remote-wins,管理员端 local-wins)。
 * - 预算:默认按月份键合并(本地优先);remote-wins 时采用远端文件。
 * - 支出按其日期所属月份重新归档:记录被改期后自动换月文件,旧月份随之清空。
 *
 * 合并输出规范化:各集合按 id 升序(支出再按日期),月份键与预算键按字典序,
 * 保证两端对同一合并结果生成逐字节相同的文件内容。
 *
 * 删除的传播:并集合并中「缺失」不是一种状态,本函数无法表达删除;
 * 删除一律通过离线队列(src/sync/queue.ts 的 replay)显式传播。
 * 推荐应用把 replay(队列为空时等价于本函数)作为同步入口。
 *
 * local 会被原地更新为合并后的状态(与领域层习惯一致)。
 */

export interface SyncResult {
  /** 合并给本地带来内容变化的远端文件数(合并结果 ≠ 本地同步前内容,且远端存在该文件) */
  pulledFiles: number
  /** 本次写回端点的文件数(putFile 与 deleteFile 都计入) */
  pushedFiles: number
  /** 记录级冲突次数:同一 id 双方都有且 updatedAt 或内容不同,由 LWW 裁决 */
  conflictsResolved: number
}

/**
 * 管理员维护文件(分类/预算)的合并策略:
 * - local-wins(默认):双方都有保留本地,管理员端据此推送自己的编辑;
 * - remote-wins:远端文件存在时采用远端版本,成员端据此采纳管理员改动。
 */
export type AdminFilesPolicy = 'local-wins' | 'remote-wins'

export interface SyncOptions {
  adminFilesPolicy?: AdminFilesPolicy
}

interface Counter {
  n: number
}

/** 记录级 LWW 裁决(规则见模块 TSDoc);counter 累计冲突次数 */
function lww<T extends { updatedAt: string }>(local: T, remote: T, counter: Counter): T {
  if (local.updatedAt !== remote.updatedAt) {
    counter.n += 1
    return local.updatedAt > remote.updatedAt ? local : remote
  }
  const localJson = JSON.stringify(local)
  const remoteJson = JSON.stringify(remote)
  if (localJson === remoteJson) return local
  counter.n += 1
  return localJson > remoteJson ? local : remote
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareExpenses(a: Expense, b: Expense): number {
  return a.date === b.date ? byId(a, b) : a.date < b.date ? -1 : 1
}

function mergeTimestamped<T extends { id: string; updatedAt: string }>(
  local: T[],
  remote: T[],
  counter: Counter,
): T[] {
  const merged = new Map<string, T>()
  for (const record of local) merged.set(record.id, record)
  for (const record of remote) {
    const existing = merged.get(record.id)
    merged.set(record.id, existing ? lww(existing, record, counter) : record)
  }
  return [...merged.values()].sort(byId)
}

/** 成员/分类:远端只补缺,双方都有保留本地(v1 规则,见模块 TSDoc) */
function mergeWithoutTimestamps<T extends { id: string }>(local: T[], remote: T[]): T[] {
  const merged = new Map<string, T>()
  for (const record of local) merged.set(record.id, record)
  for (const record of remote) {
    if (!merged.has(record.id)) merged.set(record.id, record)
  }
  return [...merged.values()].sort(byId)
}

function mergeBudgets(
  local: Record<MonthKey, Budget>,
  remote: Record<MonthKey, Budget>,
): Record<MonthKey, Budget> {
  const merged: Record<MonthKey, Budget> = {}
  const months = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort()
  for (const month of months) {
    const budget = local[month] ?? remote[month]
    if (budget) merged[month] = budget
  }
  return merged
}

/** 支出按其日期所属月份重新归档 */
function groupByMonth(expenses: Expense[]): Record<MonthKey, { expenses: Expense[] }> {
  const buckets = new Map<MonthKey, Expense[]>()
  for (const expense of expenses) {
    const month = expense.date.slice(0, 7)
    const bucket = buckets.get(month) ?? []
    bucket.push(expense)
    buckets.set(month, bucket)
  }
  const months: Record<MonthKey, { expenses: Expense[] }> = {}
  for (const month of [...buckets.keys()].sort()) {
    const bucket = buckets.get(month)
    if (bucket && bucket.length > 0) {
      bucket.sort(compareExpenses)
      months[month] = { expenses: bucket }
    }
  }
  return months
}

function mergeLedgers(
  local: LedgerData,
  remote: LedgerData,
  policies: {
    categories: AdminFilesPolicy
    tagGroups: AdminFilesPolicy
    budgets: AdminFilesPolicy
  },
): { merged: LedgerData; conflictsResolved: number } {
  const counter: Counter = { n: 0 }
  const expenses = mergeTimestamped(
    Object.values(local.months).flatMap((data) => data.expenses),
    Object.values(remote.months).flatMap((data) => data.expenses),
    counter,
  )
  const recurring = mergeTimestamped(local.meta.recurring, remote.meta.recurring, counter)
  const members = mergeWithoutTimestamps<Member>(local.meta.members, remote.meta.members)
  // 标签双方可写:按 id 并集 + LWW(记录级),与文件级策略无关
  const tags = mergeTimestamped<Tag>(local.meta.tags, remote.meta.tags, counter)
  const categories =
    policies.categories === 'remote-wins'
      ? [...remote.meta.categories].sort(byId)
      : mergeWithoutTimestamps<Category>(local.meta.categories, remote.meta.categories)
  const tagGroups =
    policies.tagGroups === 'remote-wins'
      ? [...remote.meta.tagGroups].sort(byId)
      : mergeWithoutTimestamps<TagGroup>(local.meta.tagGroups, remote.meta.tagGroups)
  const budgets =
    policies.budgets === 'remote-wins'
      ? remote.meta.budgets
      : mergeBudgets(local.meta.budgets, remote.meta.budgets)
  return {
    merged: {
      meta: {
        members,
        categories,
        tags,
        tagGroups,
        budgets,
        recurring,
      },
      months: groupByMonth(expenses),
    },
    conflictsResolved: counter.n,
  }
}

/**
 * 把 `after` 中与远端内容不同的文件增量写回端点:内容未变化不产生写操作,
 * 合并后消失的文件(空月份)从端点删除。返回写操作数(putFile 与 deleteFile 都计入)。
 */
export async function pushFiles(
  endpoint: SyncEndpoint,
  after: Record<string, string>,
  remoteFiles: Record<string, RemoteFile>,
  paths: Iterable<string>,
): Promise<number> {
  let pushed = 0
  for (const path of paths) {
    const next = after[path]
    const current = remoteFiles[path]
    if (next === undefined) {
      if (current) {
        await endpoint.deleteFile(path, current.revision)
        pushed += 1
      }
      continue
    }
    if (current?.content !== next) {
      await endpoint.putFile(path, next, current?.revision)
      pushed += 1
    }
  }
  return pushed
}

/**
 * 执行一轮同步:拉取端点文件 → 与 local 记录级合并 → 把合并后内容与远端不同的文件
 * 逐个写回(增量:内容未变化的文件不产生 putFile)。local 被原地更新为合并状态。
 * options.adminFilesPolicy 控制分类/预算的合并方向(默认 local-wins,保持既有行为);
 * remote-wins 仅在远端确实存在对应文件时生效,避免空远端清空本地。
 */
export async function sync(
  local: LedgerData,
  endpoint: SyncEndpoint,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const before = ledgerToFiles(local)
  const remoteFiles = await endpoint.listFiles()

  const remoteContent: Record<string, string> = {}
  for (const [path, file] of Object.entries(remoteFiles)) {
    if (isLedgerFilePath(path)) remoteContent[path] = file.content
  }

  const remoteWins = options.adminFilesPolicy === 'remote-wins'
  const { merged, conflictsResolved } = mergeLedgers(local, filesToLedger(remoteContent), {
    categories: remoteWins && CATEGORIES_FILE in remoteContent ? 'remote-wins' : 'local-wins',
    tagGroups: remoteWins && TAG_GROUPS_FILE in remoteContent ? 'remote-wins' : 'local-wins',
    budgets: remoteWins && BUDGETS_FILE in remoteContent ? 'remote-wins' : 'local-wins',
  })
  local.meta = merged.meta
  local.months = merged.months

  const after = ledgerToFiles(local)
  const pushedFiles = await pushFiles(
    endpoint,
    after,
    remoteFiles,
    new Set([...Object.keys(remoteContent), ...Object.keys(after)]),
  )

  let pulledFiles = 0
  for (const path of Object.keys(remoteContent)) {
    if (after[path] !== before[path]) pulledFiles += 1
  }

  return { pulledFiles, pushedFiles, conflictsResolved }
}
