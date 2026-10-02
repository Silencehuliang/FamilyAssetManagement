import { describe, expect, it } from 'vitest'
import type { AuthResult, LoginInput, SetupInput, StoredSession } from '../api'
import { ApiError } from '../api/client'
import type { Member } from '../domain'
import { ADMIN, NOW, XIAOHONG } from '../domain/fixtures'
import { MemoryLocalStore } from '../storage'
import { InMemoryEndpoint } from '../sync'
import { type AppApi, AppController } from './app-controller'

/** AppApi 测试替身:内存会话 + 可编程错误 */
class FakeApi implements AppApi {
  session: StoredSession | null = null
  probeResult: 'initialized' | 'uninitialized' = 'initialized'
  probeError: unknown = null
  members: Member[] = [XIAOHONG]
  membersError: unknown = null
  setupError: unknown = null
  loginError: unknown = null
  setupCalls = 0
  loginCalls = 0
  unauthorizedHandler: (() => void) | undefined

  getSession(): StoredSession | null {
    return this.session
  }

  clearSession(): void {
    this.session = null
  }

  setOnUnauthorized(handler: () => void): void {
    this.unauthorizedHandler = handler
  }

  async setup(input: SetupInput): Promise<AuthResult> {
    this.setupCalls += 1
    if (this.setupError) throw this.setupError
    const member: Member = {
      id: 'm-admin',
      username: input.username,
      displayName: input.displayName,
      role: 'admin',
      disabled: false,
      createdAt: NOW,
    }
    const result: AuthResult = { token: 'token-setup', member }
    this.session = result
    return result
  }

  async login(_input: LoginInput): Promise<AuthResult> {
    this.loginCalls += 1
    if (this.loginError) throw this.loginError
    const result: AuthResult = { token: 'token-login', member: XIAOHONG }
    this.session = result
    return result
  }

  async getMembers(): Promise<Member[]> {
    try {
      if (this.membersError) throw this.membersError
      return this.members
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.clearSession()
        this.unauthorizedHandler?.()
      }
      throw err
    }
  }

  async probeInitialization(): Promise<'initialized' | 'uninitialized'> {
    if (this.probeError) throw this.probeError
    return this.probeResult
  }

  listLedgerFiles(): Promise<Record<string, { content: string; revision: string }>> {
    throw new Error('测试应注入 SyncEndpoint,不应走 API 适配器')
  }

  getLedgerFile(): Promise<{ content: string; revision: string }> {
    throw new Error('unused')
  }

  putLedgerFile(): Promise<{ revision: string }> {
    throw new Error('unused')
  }

  deleteLedgerFile(): Promise<void> {
    throw new Error('unused')
  }
}

function sessionOf(member: Member): StoredSession {
  return { token: 'stored-token', member }
}

function makeController(options: {
  api: FakeApi
  store?: MemoryLocalStore
  isOnline?: () => boolean
}) {
  const store = options.store ?? new MemoryLocalStore()
  const endpoint = new InMemoryEndpoint()
  const controller = new AppController({
    api: options.api,
    store,
    endpoint,
    isOnline: options.isOnline,
  })
  return { controller, store, endpoint }
}

describe('AppController 启动流程', () => {
  it('无会话 + 仓库未初始化 → 初始化向导', async () => {
    const api = new FakeApi()
    api.probeResult = 'uninitialized'
    const { controller } = makeController({ api })

    await controller.boot()

    expect(controller.getState().phase).toBe('setup')
  })

  it('无会话 + 已初始化(401)→ 登录页', async () => {
    const api = new FakeApi()
    api.probeResult = 'initialized'
    const { controller } = makeController({ api })

    await controller.boot()

    expect(controller.getState().phase).toBe('login')
    expect(controller.getState().authError).toBeUndefined()
  })

  it('探测网络失败 → 登录页并显示原因', async () => {
    const api = new FakeApi()
    api.probeError = new ApiError(0, 'network_error', '网络连接失败')
    const { controller } = makeController({ api })

    await controller.boot()

    expect(controller.getState().phase).toBe('login')
    expect(controller.getState().authError).toBe('网络连接失败')
  })

  it('有会话 → 进入主界面:加载成员、写穿账本、首次同步播种分类', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const { controller, store, endpoint } = makeController({ api })

    await controller.boot()

    const state = controller.getState()
    expect(state.phase).toBe('ready')
    expect(state.member).toEqual(ADMIN)
    expect(state.members).toEqual([ADMIN, XIAOHONG])
    expect(state.syncStatus).toBe('synced')
    expect(controller.getLedger().meta.categories.length).toBeGreaterThan(0)

    const persisted = await store.loadLedger()
    expect(persisted?.meta.members).toEqual([ADMIN, XIAOHONG])
    expect(persisted?.meta.categories.length).toBeGreaterThan(0)
    await expect(store.loadMembers()).resolves.toEqual([ADMIN, XIAOHONG])
    // 三个 meta 文件 + 分类已落远端
    const files = await endpoint.listFiles()
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(3)
  })

  it('有会话但离线:用缓存成员进入主界面,状态 offline', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.membersError = new ApiError(0, 'network_error', '网络连接失败')
    const { controller } = makeController({ api, isOnline: () => false })

    await controller.boot()

    const state = controller.getState()
    expect(state.phase).toBe('ready')
    expect(state.member).toEqual(ADMIN)
    expect(state.members).toEqual([ADMIN])
    expect(state.syncStatus).toBe('offline')
  })

  it('会话失效(401)在启动时被清除并回登录页', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.membersError = new ApiError(401, 'unauthorized', '会话无效或已过期')
    const { controller } = makeController({ api })

    await controller.boot()

    expect(controller.getState().phase).toBe('login')
    expect(controller.getState().authError).toContain('会话已过期')
    expect(api.session).toBeNull()
  })
})

describe('AppController 登录与初始化', () => {
  it('初始化成功 → 主界面并保存会话', async () => {
    const api = new FakeApi()
    api.probeResult = 'uninitialized'
    const { controller } = makeController({ api })
    await controller.boot()

    await controller.submitSetup({ username: 'ada', displayName: '阿达', password: 'root-pw-123' })

    expect(api.setupCalls).toBe(1)
    expect(controller.getState().phase).toBe('ready')
    expect(controller.getState().member?.role).toBe('admin')
  })

  it('初始化撞上已有账户(409)→ 切到登录页并提示', async () => {
    const api = new FakeApi()
    api.setupError = new ApiError(409, 'setup_already_done', '账本已完成初始化')
    const { controller } = makeController({ api })

    await controller.submitSetup({ username: 'ada', displayName: '阿达', password: 'pw-123456' })

    expect(controller.getState().phase).toBe('login')
    expect(controller.getState().authError).toContain('已完成初始化')
  })

  it('登录失败显示错误;成功后进入主界面', async () => {
    const api = new FakeApi()
    const { controller } = makeController({ api })
    await controller.boot()
    expect(controller.getState().phase).toBe('login')

    api.loginError = new ApiError(401, 'invalid_credentials', '用户名或密码错误')
    await controller.submitLogin({ username: 'ada', password: 'wrong' })
    expect(controller.getState().phase).toBe('login')
    expect(controller.getState().authError).toBe('用户名或密码错误')

    api.loginError = null
    await controller.submitLogin({ username: 'xiaohong', password: 'pw-123456' })
    expect(controller.getState().phase).toBe('ready')
    expect(controller.getState().member).toEqual(XIAOHONG)
  })

  it('登出清会话回登录页;初始化向导可退回登录页', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    const { controller } = makeController({ api })
    await controller.boot()

    controller.logout()

    expect(api.session).toBeNull()
    expect(controller.getState().phase).toBe('login')
    expect(controller.getState().member).toBeNull()

    controller.goToLogin()
    expect(controller.getState().phase).toBe('login')
  })
})

describe('AppController 离线队列', () => {
  it('queueOp 写穿到本地存储,重启后可恢复', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    const { controller, store } = makeController({ api })
    await controller.boot()

    controller.queueOp({ type: 'delete-expense', id: 'e-1', month: '2026-10', deletedAt: NOW })
    await Promise.resolve()

    await expect(store.loadQueueOps()).resolves.toEqual([
      { type: 'delete-expense', id: 'e-1', month: '2026-10', deletedAt: NOW },
    ])
  })
})
