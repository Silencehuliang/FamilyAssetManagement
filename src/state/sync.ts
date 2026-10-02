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
import { DEFAULT_CATEGORIES, type LedgerData } from '../domain'
import type { SyncEndpoint } from '../sync'
import {
  CATEGORIES_FILE,
  type PendingQueue,
  replay,
  SyncConflictError,
  type SyncResult,
  sync,
} from '../sync'

export type SyncStatus = 'offline' | 'syncing' | 'synced' | 'error'

export interface SyncManagerDeps {
  endpoint: SyncEndpoint
  queue: PendingQueue
  ledger: LedgerData
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
   * 离线时直接置 offline 不发请求;并发调用复用同一 Promise。
   */
  syncNow(): Promise<SyncResult | null> {
    if (this.inFlight) return this.inFlight
    if (!(this.deps.isOnline ?? defaultIsOnline)()) {
      this.setStatus('offline')
      return Promise.resolve(null)
    }
    this.setStatus('syncing')
    const run = this.run().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async run(): Promise<SyncResult | null> {
    let err: unknown
    try {
      return await this.attempt()
    } catch (firstErr) {
      err = firstErr
    }
    // 乐观并发冲突:重跑一轮(重新 listFiles + 合并)通常即可收敛
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

  /** 一轮「拉取 → 合并 → 推送」;冲突时由 run() 决定是否重试 */
  private async attempt(): Promise<SyncResult> {
    const remoteBefore = await this.deps.endpoint.listFiles()
    const result = await replay(this.deps.queue, this.deps.ledger, this.deps.endpoint)

    // 首次同步到空远端:远端从未出现过分类文件且本地无分类 → 播种默认分类再推一轮
    if (!(CATEGORIES_FILE in remoteBefore) && this.deps.ledger.meta.categories.length === 0) {
      this.deps.ledger.meta.categories = structuredClone(DEFAULT_CATEGORIES)
      await sync(this.deps.ledger, this.deps.endpoint)
    }

    await this.deps.onSynced?.(result)
    this.setStatus('synced')
    return result
  }

  private setStatus(status: SyncStatus, error?: string): void {
    this.currentStatus = status
    this.lastError = error
    this.deps.onStatus?.(status, error)
  }
}
