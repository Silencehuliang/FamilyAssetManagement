/**
 * GitHub 代理同步端点(T5):把 SyncEndpoint 契约映射到 /api/ledger/* 代理接口。
 * - revision ↔ GitHub blob sha(服务端原样透传);
 * - 服务端 409 file_conflict 映射为 SyncConflictError,同步引擎据此重跑一轮合并;
 * - 该适配器只做协议映射,不含同步逻辑;契约测试用注入的 LedgerApi 假件驱动。
 */
import type { LedgerApi } from '../api/client'
import { ApiError } from '../api/client'
import type { PutResult, RemoteFile, SyncEndpoint } from './endpoint'
import { SyncConflictError } from './endpoint'

function mapError(err: unknown, path: string): unknown {
  if (err instanceof ApiError && err.code === 'file_conflict') {
    return new SyncConflictError(path, err.message)
  }
  return err
}

/** 服务端管理员专属的元数据:成员端只拉不推,避免 403 卡死同步(T8 起改由成员端采用远端版本) */
const ADMIN_ONLY_FILES = new Set(['ledger/meta/categories.json', 'ledger/meta/budgets.json'])

/** 会话角色来源;测试替身可缺省(缺省视作管理员,保持既有行为) */
interface SessionSource {
  getSession?(): { member: { role: string } } | null
}

function isAdmin(api: LedgerApi & SessionSource): boolean {
  return (api.getSession?.()?.member.role ?? 'admin') === 'admin'
}

/** 组装远端端点;api 为已登录的客户端(自动附带 Bearer 会话) */
export function createRemoteEndpoint(api: LedgerApi & SessionSource): SyncEndpoint {
  return {
    async listFiles(): Promise<Record<string, RemoteFile>> {
      return api.listLedgerFiles()
    },

    async putFile(path: string, content: string, baseRevision?: string): Promise<PutResult> {
      if (ADMIN_ONLY_FILES.has(path) && !isAdmin(api)) {
        return { revision: baseRevision ?? 'skipped' }
      }
      try {
        const { revision } = await api.putLedgerFile(path, content, baseRevision)
        return { revision }
      } catch (err) {
        throw mapError(err, path)
      }
    },

    async deleteFile(path: string, baseRevision?: string): Promise<void> {
      if (ADMIN_ONLY_FILES.has(path) && !isAdmin(api)) {
        return
      }
      try {
        await api.deleteLedgerFile(path, baseRevision)
      } catch (err) {
        throw mapError(err, path)
      }
    },
  }
}
