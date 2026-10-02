/**
 * 本地持久化(IndexedDB via Dexie):
 * - ledger:本地账本快照(单个 key='main' 记录,启动时 hydrate,变更后写穿);
 * - queue:离线待回放操作(delete 队列,见 src/sync/queue.ts);
 * - members:最后一次已知的成员视图(GET /api/members 的缓存,离线可显示经手人)。
 * 会话 JWT 不在此处(见 src/api/session.ts 的 localStorage)。
 */
import Dexie, { type Table } from 'dexie'
import type { LedgerData, Member } from '../domain'
import type { PendingOp } from '../sync/queue'

export const LEDGER_KEY = 'main'
export const MEMBERS_KEY = 'view'

export interface LedgerRecord {
  key: string
  ledger: LedgerData
  updatedAt: string
}

export interface MembersRecord {
  key: string
  members: Member[]
  updatedAt: string
}

export interface QueueRecord {
  id?: number
  op: PendingOp
}

export class LedgerDatabase extends Dexie {
  ledger!: Table<LedgerRecord, string>
  members!: Table<MembersRecord, string>
  queue!: Table<QueueRecord, number>

  constructor(name = 'family-ledger') {
    super(name)
    this.version(1).stores({
      ledger: 'key',
      members: 'key',
      queue: '++id',
    })
  }
}

/** 持久化接缝:生产用 DexieLocalStore,测试可用 MemoryLocalStore */
export interface LocalStore {
  loadLedger(): Promise<LedgerData | null>
  saveLedger(ledger: LedgerData): Promise<void>
  loadQueueOps(): Promise<PendingOp[]>
  saveQueueOps(ops: readonly PendingOp[]): Promise<void>
  loadMembers(): Promise<Member[] | null>
  saveMembers(members: Member[]): Promise<void>
}

export class DexieLocalStore implements LocalStore {
  constructor(private readonly db: LedgerDatabase = new LedgerDatabase()) {}

  async loadLedger(): Promise<LedgerData | null> {
    const record = await this.db.ledger.get(LEDGER_KEY)
    return record?.ledger ?? null
  }

  async saveLedger(ledger: LedgerData): Promise<void> {
    await this.db.ledger.put({ key: LEDGER_KEY, ledger, updatedAt: new Date().toISOString() })
  }

  async loadQueueOps(): Promise<PendingOp[]> {
    const rows = await this.db.queue.orderBy('id').toArray()
    const ops: PendingOp[] = []
    for (const row of rows) {
      if (row.op) ops.push(row.op)
    }
    return ops
  }

  async saveQueueOps(ops: readonly PendingOp[]): Promise<void> {
    await this.db.transaction('rw', this.db.queue, async () => {
      await this.db.queue.clear()
      if (ops.length > 0) {
        await this.db.queue.bulkAdd(ops.map((op) => ({ op })))
      }
    })
  }

  async loadMembers(): Promise<Member[] | null> {
    const record = await this.db.members.get(MEMBERS_KEY)
    return record?.members ?? null
  }

  async saveMembers(members: Member[]): Promise<void> {
    await this.db.members.put({ key: MEMBERS_KEY, members, updatedAt: new Date().toISOString() })
  }
}
