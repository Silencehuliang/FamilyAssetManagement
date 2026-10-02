/**
 * 同步端点:账本文件存储的最小抽象接缝。
 * 两个实现共用它:T6 的 GitHub 仓库代理适配器(生产),以及 InMemoryEndpoint
 * (测试替身,兼作未来离线模式的本地账本存储)。
 *
 * 约定:
 * - 路径均为 ADR-0005 定义的账本文件(见 src/sync/files.ts);仓库中的其他文件不参与同步
 * - revision 是端点自解释的不透明字符串(如 HTTP ETag 或 git commit-ish);
 *   调用方只在「listFiles 读到的值」与「写回时的 baseRevision」之间原样传递,永不解释其内容
 * - 同步引擎一次只跑一轮,方法可假定为串行调用
 */

/** 端点上单个文件的快照 */
export interface RemoteFile {
  content: string
  revision: string
}

export interface PutResult {
  /** 写入后的新修订号 */
  revision: string
}

export interface SyncEndpoint {
  /**
   * 全量列出端点上的账本文件(含内容与修订号)。
   * 账本规模小(家庭记账),全量列表足够;按内容哈希/字符串对比做文件级增量。
   */
  listFiles(): Promise<Record<string, RemoteFile>>

  /**
   * 创建或更新一个文件,返回写入后的新修订号。
   * 传入 baseRevision 时做乐观并发校验:端点当前修订号与之不符则抛 SyncConflictError,
   * 调用方应重新 listFiles 再走一轮合并。
   */
  putFile(path: string, content: string, baseRevision?: string): Promise<PutResult>

  /**
   * 删除一个文件。仅在「月份的最后一条支出被删、月份文件应消失」时需要
   * (四个 meta 文件永远存在);两个实现都平凡支持,故为必选方法。
   */
  deleteFile(path: string, baseRevision?: string): Promise<void>
}

/** 乐观并发校验失败:端点上该文件的修订号已不是调用方基线所见的修订号 */
export class SyncConflictError extends Error {
  constructor(
    public readonly path: string,
    message?: string,
  ) {
    super(message ?? `端点修订冲突:${path}`)
    this.name = 'SyncConflictError'
  }
}
