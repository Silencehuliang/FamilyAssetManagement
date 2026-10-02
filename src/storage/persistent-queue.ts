/**
 * 持久化待回放队列:在 PendingQueue 之上把每次登记/清空写穿到 LocalStore。
 * replay() 只认识 PendingQueue,因此这里仅覆写 record/clear 做持久化副作用;
 * 崩溃导致清空与落盘之间丢失时,重复回放是幂等的(删除操作只作用于仍存在的记录)。
 */
import { type PendingOp, PendingQueue } from '../sync/queue'
import type { LocalStore } from './db'

export class PersistentQueue extends PendingQueue {
  private readonly store: Pick<LocalStore, 'saveQueueOps'>

  constructor(store: Pick<LocalStore, 'saveQueueOps'>, initial: readonly PendingOp[] = []) {
    super()
    this.store = store
    for (const op of initial) {
      super.record(op)
    }
  }

  /** 从持久化存储恢复队列(启动时调用) */
  static async hydrate(store: LocalStore): Promise<PersistentQueue> {
    const ops = await store.loadQueueOps()
    return new PersistentQueue(store, ops)
  }

  override record(op: PendingOp): void {
    super.record(op)
    this.persist()
  }

  override clear(): void {
    super.clear()
    this.persist()
  }

  private persist(): void {
    void this.store.saveQueueOps(this.pending).catch((error: unknown) => {
      console.error('待回放队列持久化失败', error)
    })
  }
}
