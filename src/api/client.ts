/**
 * 客户端 API 层:对 Cloudflare Pages Functions 的薄封装。
 * - 会话 JWT 存 localStorage(fl.session),请求自动附带 Authorization: Bearer;
 * - 服务端错误契约 {error, message} 映射为 ApiError(status, code, message);
 * - 任何 401 都清空本地会话并通知订阅者(界面回到登录页);
 * - fetch 可注入,便于测试;网络层失败映射为 code=network_error(供同步层判定离线)。
 */
import type { Member } from '../domain'
import {
  clearStoredSession,
  defaultSessionStorage,
  loadStoredSession,
  type StorageLike,
  type StoredSession,
  saveStoredSession,
} from './session'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 服务端错误契约 {error, message} 的客户端形态;status 0 表示网络层失败 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ApiError'
  }
}

export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'network_error'
}

export interface AuthResult {
  token: string
  member: Member
}

export interface LoginInput {
  username: string
  password: string
}

export interface SetupInput extends LoginInput {
  displayName: string
}

/** 服务端账本文件形态:revision 即 GitHub blob sha */
export interface LedgerFilePayload {
  content: string
  revision: string
}

/** 客户端消费的 API 接缝(remote 同步适配器、启动流程都依赖它,便于测试替身) */
export interface LedgerApi {
  setup(input: SetupInput): Promise<AuthResult>
  login(input: LoginInput): Promise<AuthResult>
  getMembers(): Promise<Member[]>
  listLedgerFiles(): Promise<Record<string, LedgerFilePayload>>
  getLedgerFile(path: string): Promise<LedgerFilePayload>
  putLedgerFile(path: string, content: string, baseRevision?: string): Promise<{ revision: string }>
  deleteLedgerFile(path: string, baseRevision?: string): Promise<void>
  /** 未认证探测仓库是否已初始化:uninitialized → 初始化向导,initialized → 登录页 */
  probeInitialization(): Promise<'initialized' | 'uninitialized'>
}

export interface ApiClientOptions {
  /** 同源部署时留空;测试或分域部署可指定 */
  baseUrl?: string
  fetchImpl?: FetchLike
  storage?: StorageLike
  /** 401 清空会话后的回调(界面切回登录页) */
  onUnauthorized?: () => void
}

interface RequestOptions extends RequestInit {
  /** 默认 true;初始化探测需要显式关闭 */
  auth?: boolean
}

export class ApiClient implements LedgerApi {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly storage: StorageLike
  private session: StoredSession | null
  private onUnauthorized: () => void

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.storage = options.storage ?? defaultSessionStorage()
    this.onUnauthorized = options.onUnauthorized ?? (() => {})
    this.session = loadStoredSession(this.storage)
  }

  /** 运行时可替换 401 回调(控制器在 ApiClient 之后组装) */
  setOnUnauthorized(handler: () => void): void {
    this.onUnauthorized = handler
  }

  getSession(): StoredSession | null {
    return this.session
  }

  get token(): string | null {
    return this.session?.token ?? null
  }

  setSession(session: StoredSession): void {
    this.session = session
    saveStoredSession(session, this.storage)
  }

  clearSession(): void {
    this.session = null
    clearStoredSession(this.storage)
  }

  async setup(input: SetupInput): Promise<AuthResult> {
    const result = await this.request<AuthResult>('/api/setup', {
      method: 'POST',
      body: JSON.stringify(input),
      auth: false,
    })
    this.setSession(result)
    return result
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const result = await this.request<AuthResult>('/api/login', {
      method: 'POST',
      body: JSON.stringify(input),
      auth: false,
    })
    this.setSession(result)
    return result
  }

  async getMembers(): Promise<Member[]> {
    const body = await this.request<{ members: Member[] }>('/api/members')
    return body.members
  }

  async listLedgerFiles(): Promise<Record<string, LedgerFilePayload>> {
    const body = await this.request<{ files: Record<string, LedgerFilePayload> }>(
      '/api/ledger/list',
    )
    return body.files
  }

  async getLedgerFile(path: string): Promise<LedgerFilePayload> {
    const body = await this.request<{ content: string; sha: string }>(
      `/api/ledger/file?path=${encodeURIComponent(path)}`,
    )
    return { content: body.content, revision: body.sha }
  }

  async putLedgerFile(
    path: string,
    content: string,
    baseRevision?: string,
  ): Promise<{ revision: string }> {
    const body = await this.request<{ sha: string }>('/api/ledger/file', {
      method: 'PUT',
      body: JSON.stringify({ path, content, sha: baseRevision }),
    })
    return { revision: body.sha }
  }

  async deleteLedgerFile(path: string, baseRevision?: string): Promise<void> {
    let revision = baseRevision
    if (revision === undefined) {
      // SyncEndpoint.deleteFile 允许不带基线:取当前 sha 兜底;文件已不存在则无事可做
      try {
        revision = (await this.getLedgerFile(path)).revision
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return
        throw err
      }
    }
    await this.request<{ deleted: true }>('/api/ledger/file', {
      method: 'DELETE',
      body: JSON.stringify({ path, sha: revision }),
    })
  }

  async probeInitialization(): Promise<'initialized' | 'uninitialized'> {
    try {
      await this.request<{ members: Member[] }>('/api/members', { auth: false })
      return 'initialized'
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'members_file_missing') return 'uninitialized'
        if (err.status === 401) return 'initialized'
      }
      throw err
    }
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { auth = true, headers, ...init } = options
    const finalHeaders = new Headers(headers)
    if (init.body !== undefined && !finalHeaders.has('Content-Type')) {
      finalHeaders.set('Content-Type', 'application/json')
    }
    if (auth && this.session) {
      finalHeaders.set('Authorization', `Bearer ${this.session.token}`)
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers: finalHeaders })
    } catch {
      throw new ApiError(0, 'network_error', '网络连接失败')
    }

    if (!response.ok) {
      const body = await safeJsonObject(response)
      const code = typeof body?.error === 'string' ? body.error : 'http_error'
      const message =
        typeof body?.message === 'string' ? body.message : `请求失败(${response.status})`
      if (response.status === 401) {
        this.clearSession()
        this.onUnauthorized()
      }
      throw new ApiError(response.status, code, message)
    }

    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }
}

async function safeJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
