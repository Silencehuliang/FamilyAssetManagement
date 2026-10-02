/**
 * 同步编排(T5):把「谁在什么时候同步」与同步引擎解耦。
 * - 入口统一走 replay(queue, local, endpoint):离线期间的增/改由 LWW 合并传播,
 *   离线删除由持久化队列显式回放(见 src/sync/queue.ts);
 * - 首次同步到空远端(从未有过 categories.json)且本地无分类时,播种 DEFAULT_CATEGORIES 并推送,
 *   让家人首次登录就能看到分类;
 * - 状态机暴露给界面:offline | syncing | synced | error(带最后错误信息);
 * - 并发调用合并为同一轮(界面进入即触发 + 在线事件 + 手动重试可能叠加)。
 */
import { ApiError } from '../api/client'
import { DEFAULT_CATEGORIES, type LedgerData, type Role } from '../domain'
import type { SyncEndpoint } from '../sync'
import {
  type AdminFilesPolicy,
  CATEGORIES_FILE,
  type PendingQueue,
  replay,
  SyncConflictError,
  type SyncResult,
} from '../sync'

export type SyncStatus = 'offline' | 'syncing' | 'synced' | 'error'

export interface SyncManagerDeps {
  endpoint: SyncEndpoint
  queue: PendingQueue
  ledger: LedgerData
  /**
   * 当前登录成员的角色(经 api.getSession 读取)。成员端对分类/预算采用远端版本,
   * 避免用本地旧副本回推管理员的改动;缺省视作管理员,保持既有 local-wins 行为。
   */
  getRole?: () => Role | undefined
  /** 默认读 navigator.onLine;测试注入 */
  isOnline?: () => boolean
  /** 状态变化回调(界面刷新徽标) */
  onStatus?: (status: SyncStatus, error?: string) => void
  /** 一轮同步成功后的收尾(把账本/队列写穿到本地存储) */
  onSynced?: (result: SyncResult) => Promise<void> | void
}

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return '同步失败'
}

export class SyncManager {
  private readonly deps: SyncManagerDeps
  private inFlight: Promise<SyncResult | null> | null = null
  /** 本轮同步进行中又收到同步请求:结束当前轮后立刻补跑一轮,避免新变更滞留本地 */
  private pendingRerun = false
  private currentStatus: SyncStatus = 'offline'
  private lastError: string | undefined

  constructor(deps: SyncManagerDeps) {
    this.deps = deps
  }

  get status(): SyncStatus {
    return this.currentStatus
  }

  get error(): string | undefined {
    return this.lastError
  }

  /** 浏览器离线事件/网络失败后把状态置为 offline(同步中不打断,等本轮结果) */
  markOffline(): void {
    if (this.currentStatus !== 'syncing') {
      this.setStatus('offline')
    }
  }

  /**
   * 跑一轮同步。永不抛错:失败体现在 status/lastError 上,便于界面「重试」按钮调用。
   * 离线时直接置 offline 不发请求;并发调用复用同一 Promise,但会登记一轮补跑,
   * 保证「同步进行中产生的变更」在下一轮立即推送(而不是拖到下一次触发)。
   */
  syncNow(): Promise<SyncResult | null> {
    if (this.inFlight) {
      this.pendingRerun = true
      return this.inFlight
    }
    if (!(this.deps.isOnline ?? defaultIsOnline)()) {
      this.setStatus('offline')
      return Promise.resolve(null)
    }
    this.setStatus('syncing')
    const run = this.run().finally(() => {
      this.inFlight = null
      this.pendingRerun = false
    })
    this.inFlight = run
    return run
  }

  private async run(): Promise<SyncResult | null> {
    let result = await this.attemptWithRetry()
    while (this.pendingRerun) {
      this.pendingRerun = false
      result = (await this.attemptWithRetry()) ?? result
    }
    return result
  }

  /** 单次尝试;乐观并发冲突时重跑一轮(重新 listFiles + 合并)通常即可收敛 */
  private async attemptWithRetry(): Promise<SyncResult | null> {
    let err: unknown
    try {
      return await this.attempt()
    } catch (firstErr) {
      err = firstErr
    }
    if (err instanceof SyncConflictError) {
      try {
        return await this.attempt()
      } catch (retryErr) {
        err = retryErr
      }
    }
    if (err instanceof ApiError && err.code === 'network_error') {
      this.setStatus('offline')
      return null
    }
    // fetch 层直接抛 TypeError 的替身(无 ApiError 包装)同样按离线处理
    if (err instanceof TypeError) {
      this.setStatus('offline')
      return null
    }
    this.setStatus('error', errorText(err))
    return null
  }

  /** 一轮「拉取 → 合并 → 推送」 */
  private async attempt(): Promise<SyncResult> {
    const remoteBefore = await this.deps.endpoint.listFiles()

    // 首次同步到空远端(从未出现过分类文件)且本地无分类:先播种默认分类再合并推送,
    // 让家人首次登录就能看到分类。必须在 replay 之前播种:成员端 remote-wins 会在
    // 合并时采用远端分类文件,若空文件先被推到远端,播种会被清空。
    if (!(CATEGORIES_FILE in remoteBefore) && this.deps.ledger.meta.categories.length === 0) {
      this.deps.ledger.meta.categories = structuredClone(DEFAULT_CATEGORIES)
    }

    const result = await replay(this.deps.queue, this.deps.ledger, this.deps.endpoint, {
      adminFilesPolicy: this.adminFilesPolicy(),
    })
    await this.deps.onSynced?.(result)
    this.setStatus('synced')
    return result
  }

  /** 成员端 remote-wins(采纳管理员维护的分类/预算),管理员端 local-wins(保住自己的编辑) */
  private adminFilesPolicy(): AdminFilesPolicy {
    return (this.deps.getRole?.() ?? 'admin') === 'admin' ? 'local-wins' : 'remote-wins'
  }

  private setStatus(status: SyncStatus, error?: string): void {
    this.currentStatus = status
    this.lastError = error
    this.deps.onStatus?.(status, error)
  }
}
