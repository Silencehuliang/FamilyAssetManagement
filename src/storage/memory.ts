/**
 * 内存持久化:测试替身与 IndexedDB 不可用时的降级实现。
 * 写入即克隆,避免调用方后续原地修改账本影响"已持久化"的快照语义。
 */
import type { LedgerData, Member } from '../domain'
import type { PendingOp } from '../sync/queue'
import type { LocalStore } from './db'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class MemoryLocalStore implements LocalStore {
  private ledger: LedgerData | null = null
  private members: Member[] | null = null
  private queueOps: PendingOp[] = []

  async loadLedger(): Promise<LedgerData | null> {
    return this.ledger ? clone(this.ledger) : null
  }

  async saveLedger(ledger: LedgerData): Promise<void> {
    this.ledger = clone(ledger)
  }

  async loadQueueOps(): Promise<PendingOp[]> {
    return clone(this.queueOps)
  }

  async saveQueueOps(ops: readonly PendingOp[]): Promise<void> {
    this.queueOps = clone([...ops])
  }

  async loadMembers(): Promise<Member[] | null> {
    return this.members ? clone(this.members) : null
  }

  async saveMembers(members: Member[]): Promise<void> {
    this.members = clone(members)
  }
}
