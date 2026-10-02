import type { PutResult, RemoteFile, SyncEndpoint } from './endpoint'
import { SyncConflictError } from './endpoint'

/**
 * 内存端点:Map 之上的 SyncEndpoint 假实现,一物二用——
 * 1. 测试替身:无需网络即可驱动同步引擎;
 * 2. 未来离线模式的本地账本存储适配器(与 T6 的 GitHub 适配器同接口)。
 *
 * 保持零依赖、内部纯同步(async 仅为满足接口);修订号为自增的 `rev-<n>`。
 */
export class InMemoryEndpoint implements SyncEndpoint {
  private readonly files = new Map<string, RemoteFile>()
  private seq = 0

  /** 以 { 路径: 内容 } 形式注入初始文件(如 ledgerToFiles 的产物) */
  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.assignFile(path, content)
    }
  }

  /** 测试辅助:绕过乐观并发校验直接放置/覆盖一个文件 */
  assignFile(path: string, content: string): void {
    this.files.set(path, { content, revision: this.nextRevision() })
  }

  async listFiles(): Promise<Record<string, RemoteFile>> {
    const snapshot: Record<string, RemoteFile> = {}
    for (const [path, file] of this.files) {
      snapshot[path] = { ...file }
    }
    return snapshot
  }

  async putFile(path: string, content: string, baseRevision?: string): Promise<PutResult> {
    this.assertBaseRevision(path, baseRevision)
    const file: RemoteFile = { content, revision: this.nextRevision() }
    this.files.set(path, file)
    return { revision: file.revision }
  }

  async deleteFile(path: string, baseRevision?: string): Promise<void> {
    this.assertBaseRevision(path, baseRevision)
    this.files.delete(path)
  }

  private assertBaseRevision(path: string, baseRevision: string | undefined): void {
    const current = this.files.get(path)
    if (baseRevision !== undefined && current && current.revision !== baseRevision) {
      throw new SyncConflictError(path)
    }
  }

  private nextRevision(): string {
    this.seq += 1
    return `rev-${this.seq}`
  }
}
