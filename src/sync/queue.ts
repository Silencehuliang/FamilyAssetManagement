import type {
  CategoryId,
  ExpenseId,
  LedgerData,
  MonthKey,
  RecurringId,
  TagGroupId,
  TagId,
} from '../domain'
import { expenseTagIds } from '../domain'
import type { SyncEndpoint } from './endpoint'
import type { SyncOptions, SyncResult } from './engine'
import { pushFiles, sync } from './engine'
import {
  BUDGETS_FILE,
  CATEGORIES_FILE,
  ledgerToFiles,
  monthFilePath,
  RECURRING_FILE,
  TAG_GROUPS_FILE,
  TAGS_FILE,
} from './files'

/**
 * 离线待回放队列与恢复回放。
 *
 * 设计取舍:离线期间的「增/改」已由领域层写入本地账本,回放交给 sync() 的记录级
 * LWW 合并即可正确传到远端(时间戳新的传上去,旧的被远端新版本覆盖),无需逐条登记;
 * 唯一合并表达不了的是「删除」——并集合并中「本地没有」不构成删除,直接 sync 会让
 * 远端旧记录复活。因此队列只登记删除操作,按登记顺序回放(「按序回放」):
 *
 * - 删除支出/周期支出携带删除时刻 deletedAt:回放时若合并结果中同 id 记录仍存在、
 *   且其 updatedAt ≤ deletedAt,则补删并推送(晚于删除的编辑按 LWW 胜出,予以保留)。
 *   时间为 ISO-8601 字符串,可直接做字典序比较。
 * - 删除成员/分类/标签/标签组、清空预算:无时间戳,按本地意图补删(本地为准);
 *   标签删除还会再次清理支出与标签组中的引用,并推送实际变化的文件。
 *
 * 已知限制(v1):墓碑不进入同步数据。若另一台设备从未同步过这次删除、其旧副本仍
 * 持有该记录,它的下一轮 sync 会把记录推回远端。跨设备删除传播需要把墓碑持久化进
 * 账本数据或引入三方合并基线,超出本票范围。
 */

export type PendingOp =
  | {
      type: 'delete-expense'
      id: ExpenseId
      /** 删除时记录所在月,回放时优先在该月定位 */
      month: MonthKey
      deletedAt: string
    }
  | { type: 'delete-recurring'; id: RecurringId; deletedAt: string }
  | { type: 'delete-category'; id: CategoryId }
  | { type: 'delete-tag'; id: TagId }
  | { type: 'delete-tag-group'; id: TagGroupId }
  | { type: 'clear-budget'; month: MonthKey }
// 注:成员数据由服务端专管(members.json 不属同步文件集),成员的停用/删除
// 走鉴权端点,不经离线队列。

/** 离线期间登记的操作日志,恢复连接时由 replay 一次性回放并清空 */
export class PendingQueue {
  private readonly ops: PendingOp[] = []

  /** 登记一条离线操作(调用方在领域层应用变更之后调用) */
  record(op: PendingOp): void {
    this.ops.push(op)
  }

  /** 待回放操作(按登记顺序) */
  get pending(): readonly PendingOp[] {
    return this.ops
  }

  get size(): number {
    return this.ops.length
  }

  clear(): void {
    this.ops.length = 0
  }
}

function applyDeleteOp(local: LedgerData, op: PendingOp, touched: Set<string>): void {
  switch (op.type) {
    case 'delete-expense': {
      // 先在登记的月份找,再兜底全量找(记录可能被改期)
      const monthOrder = [op.month, ...Object.keys(local.months)]
      for (const month of monthOrder) {
        const data = local.months[month]
        if (!data) continue
        const expense = data.expenses.find((e) => e.id === op.id)
        if (!expense) continue
        if (expense.updatedAt <= op.deletedAt) {
          const remaining = data.expenses.filter((e) => e.id !== op.id)
          if (remaining.length === 0) delete local.months[month]
          else local.months[month] = { expenses: remaining }
          touched.add(monthFilePath(month))
        }
        break
      }
      return
    }
    case 'delete-recurring': {
      const recurring = local.meta.recurring.find((r) => r.id === op.id)
      if (recurring && recurring.updatedAt <= op.deletedAt) {
        local.meta.recurring = local.meta.recurring.filter((r) => r.id !== op.id)
        touched.add(RECURRING_FILE)
      }
      return
    }
    case 'delete-category': {
      const before = local.meta.categories.length
      local.meta.categories = local.meta.categories.filter((c) => c.id !== op.id)
      if (local.meta.categories.length !== before) touched.add(CATEGORIES_FILE)
      return
    }
    case 'delete-tag': {
      const hadTag = local.meta.tags.some((t) => t.id === op.id)
      local.meta.tags = local.meta.tags.filter((t) => t.id !== op.id)
      if (hadTag) touched.add(TAGS_FILE)
      // 防御性再清理:并集合并可能从远端旧副本复活引用;实际变化的文件一并推送
      for (const [month, data] of Object.entries(local.months)) {
        let changed = false
        const expenses = data.expenses.map((expense) => {
          const tagIds = expenseTagIds(expense)
          if (!tagIds.includes(op.id)) return expense
          changed = true
          return { ...expense, tagIds: tagIds.filter((tagId) => tagId !== op.id) }
        })
        if (changed) {
          local.months[month] = { expenses }
          touched.add(monthFilePath(month))
        }
      }
      let groupsChanged = false
      local.meta.tagGroups = local.meta.tagGroups.map((group) => {
        if (!group.tagIds.includes(op.id)) return group
        groupsChanged = true
        return { ...group, tagIds: group.tagIds.filter((tagId) => tagId !== op.id) }
      })
      if (groupsChanged) touched.add(TAG_GROUPS_FILE)
      return
    }
    case 'delete-tag-group': {
      const before = local.meta.tagGroups.length
      local.meta.tagGroups = local.meta.tagGroups.filter((g) => g.id !== op.id)
      if (local.meta.tagGroups.length !== before) touched.add(TAG_GROUPS_FILE)
      return
    }
    case 'clear-budget': {
      if (local.meta.budgets[op.month]) {
        delete local.meta.budgets[op.month]
        touched.add(BUDGETS_FILE)
      }
      return
    }
  }
}

/**
 * 恢复连接:先跑一轮常规同步(离线期间的增/改经 LWW 合并传播),再按登记顺序
 * 补放删除操作,把受影响文件写回端点(月份清空时删除端点文件),最后清空队列。
 * 队列为空时等价于 sync(local, endpoint, options);options 透传合并策略(见 engine)。
 */
export async function replay(
  queue: PendingQueue,
  local: LedgerData,
  endpoint: SyncEndpoint,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const result = await sync(local, endpoint, options)

  const ops = [...queue.pending]
  if (ops.length > 0) {
    const touched = new Set<string>()
    for (const op of ops) applyDeleteOp(local, op, touched)

    const after = ledgerToFiles(local)
    const remoteFiles = await endpoint.listFiles()
    result.pushedFiles += await pushFiles(endpoint, after, remoteFiles, touched)
  }

  queue.clear()
  return result
}
