import { describe, expect, it } from 'vitest'
import type {
  AuthResult,
  ChangePasswordInput,
  CreateMemberInput,
  LoginInput,
  ResetPasswordInput,
  SetMemberStatusInput,
  SetupInput,
  StoredSession,
} from '../api'
import { ApiError } from '../api/client'
import {
  addExpense,
  DEFAULT_CATEGORIES,
  type LedgerData,
  type Member,
  tagIdFromName,
} from '../domain'
import { ADMIN, fixtureLedger, LUNCH_CATEGORY, NOW, XIAOHONG } from '../domain/fixtures'
import { expenseToForm } from '../features/entries'
import { sortedTagGroups } from '../features/tags'
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
  createMemberError: unknown = null
  statusError: unknown = null
  resetPasswordError: unknown = null
  changePasswordError: unknown = null
  readonly statusCalls: SetMemberStatusInput[] = []
  readonly resetCalls: ResetPasswordInput[] = []
  readonly changePasswordCalls: ChangePasswordInput[] = []

  getSession(): StoredSession | null {
    return this.session
  }

  clearSession(): void {
    this.session = null
  }

  setOnUnauthorized(handler: () => void): void {
    this.unauthorizedHandler = handler
  }

  async createMember(input: CreateMemberInput): Promise<Member> {
    if (this.createMemberError) throw this.createMemberError
    const member: Member = {
      id: `id-${input.username}`,
      username: input.username,
      displayName: input.displayName,
      role: input.role ?? 'member',
      disabled: false,
      createdAt: NOW,
    }
    this.members = [...this.members, member]
    return member
  }

  async setMemberStatus(input: SetMemberStatusInput): Promise<Member> {
    if (this.statusError) throw this.statusError
    this.statusCalls.push({ ...input })
    this.members = this.members.map((m) =>
      m.id === input.memberId ? { ...m, disabled: input.disabled } : m,
    )
    const updated = this.members.find((m) => m.id === input.memberId)
    if (!updated) throw new ApiError(404, 'member_not_found', '成员不存在')
    return updated
  }

  async resetMemberPassword(input: ResetPasswordInput): Promise<Member> {
    if (this.resetPasswordError) throw this.resetPasswordError
    this.resetCalls.push({ ...input })
    return this.members.find((m) => m.id === input.memberId) ?? XIAOHONG
  }

  async changePassword(input: ChangePasswordInput): Promise<Member> {
    if (this.changePasswordError) throw this.changePasswordError
    this.changePasswordCalls.push({ ...input })
    return this.session?.member ?? XIAOHONG
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
  now?: () => Date
  newId?: () => string
  today?: () => string
}) {
  const store = options.store ?? new MemoryLocalStore()
  const endpoint = new InMemoryEndpoint()
  const controller = new AppController({
    api: options.api,
    store,
    endpoint,
    isOnline: options.isOnline,
    now: options.now,
    newId: options.newId,
    today: options.today,
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

describe('v1 缓存升级路径(评审修复)', () => {
  it('boot 规范化缺 tags/tagGroups 的旧缓存:同步成功、迁移运行、标签出现并写回缓存', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const store = new MemoryLocalStore()
    // v1 形状:meta 没有 tags/tagGroups;支出只有废弃的自由文本 tagNames
    const v1 = {
      meta: {
        members: [ADMIN, XIAOHONG],
        categories: structuredClone(DEFAULT_CATEGORIES),
        budgets: {},
        recurring: [],
      },
      months: {
        '2026-10': {
          expenses: [
            {
              id: 'e-legacy',
              amountCents: 1000,
              date: '2026-10-02',
              categoryId: 'cat-dining-2',
              tagNames: ['微信', '现金'],
              memberId: ADMIN.id,
              recordedBy: ADMIN.id,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      },
    } as unknown as LedgerData
    await store.saveLedger(v1)
    const { controller, endpoint } = makeController({
      api,
      store,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      today: () => '2026-10-02',
    })

    await controller.boot()

    // 旧缓存缺 tags 时合并若抛错会被吞成离线;这里必须完成一轮同步并运行迁移
    expect(controller.getState().syncStatus).toBe('synced')
    const wechat = await tagIdFromName('微信')
    const cash = await tagIdFromName('现金')
    const ledger = controller.getLedger()
    expect(ledger.meta.tags.map((t) => t.id).sort()).toEqual([wechat, cash].sort())
    const expense = ledger.months['2026-10']?.expenses[0]
    expect(expense?.tagIds.slice().sort()).toEqual([wechat, cash].sort())
    expect(expense && 'tagNames' in expense).toBe(false)

    // 规范化后的形状已写回本地缓存(下次启动不再从旧形状起步)
    const persisted = await store.loadLedger()
    expect(persisted?.meta.tagGroups).toEqual([])
    expect(persisted?.meta.tags).toHaveLength(2)

    // 迁移结果推送到远端:tags.json 出现且不含废弃字段
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/tags.json']?.content).toContain('微信')
    expect(files['ledger/months/2026-10.json']?.content).not.toContain('tagNames')
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

describe('AppController 记一笔(T6)', () => {
  async function readyController() {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      newId: () => 'e-fixed',
    })
    await made.controller.boot()
    return made
  }

  const baseForm = {
    amountText: '12.5',
    parentId: 'cat-dining',
    categoryId: 'cat-dining-2',
    date: '2026-10-02',
    note: ' 食堂 ',
    tagsText: '微信, 现金',
    memberId: '',
  }

  it('默认经手人为登录成员;写穿本地并同步到端点', async () => {
    const { controller, store, endpoint } = await readyController()
    const wechat = await tagIdFromName('微信')
    const cash = await tagIdFromName('现金')

    const expense = await controller.recordExpense(baseForm)

    expect(expense).toMatchObject({
      id: 'e-fixed',
      amountCents: 1250,
      memberId: ADMIN.id,
      recordedBy: ADMIN.id,
      note: '食堂',
      tagIds: [wechat, cash],
    })
    expect(expense).not.toHaveProperty('tagNames')
    // 旧编辑器的标签文本已按确定性 id 补建实体(评审修复:旧编辑兼容层 tagId 化)
    expect(controller.getLedger().meta.tags).toEqual([
      { id: wechat, name: '微信', updatedAt: '2026-10-02T08:30:00.000Z' },
      { id: cash, name: '现金', updatedAt: '2026-10-02T08:30:00.000Z' },
    ])
    const persisted = await store.loadLedger()
    expect(persisted?.months['2026-10']?.expenses).toHaveLength(1)
    expect(persisted?.meta.tags).toHaveLength(2)

    // recordExpense 的同步是 fire-and-forget;retrySync 会复用进行中的一轮并等待它
    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/months/2026-10.json']?.content).toContain('"amountCents": 1250')
    expect(files['ledger/meta/tags.json']?.content).toContain('微信')
  })

  it('可代其他成员记录:memberId 为经手人,recordedBy 仍为记录者', async () => {
    const { controller } = await readyController()

    const expense = await controller.recordExpense({ ...baseForm, memberId: XIAOHONG.id })

    expect(expense.memberId).toBe(XIAOHONG.id)
    expect(expense.recordedBy).toBe(ADMIN.id)
  })

  it('金额为 0 或未选子分类时拒绝且不写入', async () => {
    const { controller, store } = await readyController()

    await expect(controller.recordExpense({ ...baseForm, amountText: '0' })).rejects.toThrow(/金额/)
    await expect(
      controller.recordExpense({ ...baseForm, categoryId: 'cat-dining' }),
    ).rejects.toThrow(/子分类/)
    expect((await store.loadLedger())?.months['2026-10']).toBeUndefined()
  })

  it('账本无分类时(离线首启)播种默认分类后可立即记账', async () => {
    const { controller } = await readyController()
    controller.getLedger().meta.categories = []

    const expense = await controller.recordExpense(baseForm)

    expect(expense.categoryId).toBe('cat-dining-2')
    expect(controller.getLedger().meta.categories.length).toBeGreaterThan(0)
  })
})

describe('AppController 明细页编辑与删除(T7)', () => {
  const baseForm = {
    amountText: '12.5',
    parentId: 'cat-dining',
    categoryId: 'cat-dining-2',
    date: '2026-10-02',
    note: ' 食堂 ',
    tagsText: '微信',
    memberId: '',
  }

  async function readyController(actor: Member = ADMIN) {
    const api = new FakeApi()
    api.session = sessionOf(actor)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      newId: () => 'e-fixed',
    })
    await made.controller.boot()
    return made
  }

  it('updateExpense:补丁本地生效、写穿存储并同步到端点', async () => {
    const { controller, store, endpoint } = await readyController()
    await controller.recordExpense(baseForm)

    await controller.updateExpense('e-fixed', {
      ...baseForm,
      amountText: '20',
      categoryId: 'cat-dining-3',
      note: '',
      tagsText: '',
      memberId: XIAOHONG.id,
    })

    const updated = controller.getLedger().months['2026-10']?.expenses[0]
    expect(updated).toMatchObject({
      amountCents: 2000,
      categoryId: 'cat-dining-3',
      memberId: XIAOHONG.id,
      recordedBy: ADMIN.id,
      tagIds: [],
    })
    expect(updated && 'tagNames' in updated).toBe(false)
    expect(updated?.note).toBeUndefined()
    expect((await store.loadLedger())?.months['2026-10']?.expenses[0]?.amountCents).toBe(2000)

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/months/2026-10.json']?.content).toContain('"amountCents": 2000')
  })

  it('旧编辑器编辑已迁移支出:标签以实体 id 保留,tagNames 不复活(评审回归)', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const store = new MemoryLocalStore()
    const wechat = await tagIdFromName('微信')
    const seed = fixtureLedger()
    seed.meta.tags = [{ id: wechat, name: '微信', updatedAt: NOW }]
    seed.months = {
      '2026-10': {
        expenses: [
          {
            id: 'e-migrated',
            amountCents: 1000,
            date: '2026-10-02',
            categoryId: 'cat-dining-2',
            tagIds: [wechat],
            memberId: ADMIN.id,
            recordedBy: ADMIN.id,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    }
    await store.saveLedger(seed)
    const { controller } = makeController({
      api,
      store,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
    })
    await controller.boot()

    // 旧编辑器回填:按实体把 tagIds 解析成名字
    const before = controller.getLedger().months['2026-10']?.expenses[0]
    if (!before) throw new Error('fixture: 支出缺失')
    expect(expenseToForm(controller.getLedger(), before).tagsText).toBe('微信')

    await controller.updateExpense('e-migrated', {
      ...baseForm,
      amountText: '12.5',
      tagsText: '微信',
    })

    const updated = controller.getLedger().months['2026-10']?.expenses[0]
    expect(updated?.tagIds).toEqual([wechat])
    expect(updated && 'tagNames' in updated).toBe(false)
    // 实体未被重复创建,也没有因旧编辑器的空 tagNames 被清掉
    expect(controller.getLedger().meta.tags).toEqual([{ id: wechat, name: '微信', updatedAt: NOW }])
  })

  it('updateExpense:改他人的记录被领域层拒绝,记录保持原样', async () => {
    const { controller } = await readyController(XIAOHONG)
    const ledger = controller.getLedger()
    addExpense(
      ledger,
      { amountCents: 500, date: '2026-10-02', categoryId: 'cat-dining-2' },
      { actor: ADMIN, now: NOW, newId: 'e-other' },
    )

    await expect(
      controller.updateExpense('e-other', { ...baseForm, amountText: '99' }),
    ).rejects.toThrow(/只能修改/)
    expect(ledger.months['2026-10']?.expenses[0]?.amountCents).toBe(500)
  })

  it('deleteExpense:本地删除 + 登记墓碑,同步后远端月份文件消失、队列清空', async () => {
    const { controller, store, endpoint } = await readyController()
    await controller.recordExpense(baseForm)
    await controller.retrySync()
    expect((await endpoint.listFiles())['ledger/months/2026-10.json']).toBeDefined()

    await controller.deleteExpense('e-fixed')

    expect(controller.getLedger().months['2026-10']).toBeUndefined()
    expect((await store.loadLedger())?.months['2026-10']).toBeUndefined()
    await expect(store.loadQueueOps()).resolves.toEqual([
      {
        type: 'delete-expense',
        id: 'e-fixed',
        month: '2026-10',
        deletedAt: '2026-10-02T08:30:00.000Z',
      },
    ])

    await controller.retrySync()
    expect((await endpoint.listFiles())['ledger/months/2026-10.json']).toBeUndefined()
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })

  it('deleteExpense:删除他人的记录被拒绝,记录保留', async () => {
    const { controller, store } = await readyController(XIAOHONG)
    const ledger = controller.getLedger()
    addExpense(
      ledger,
      { amountCents: 500, date: '2026-10-02', categoryId: 'cat-dining-2' },
      { actor: ADMIN, now: NOW, newId: 'e-other' },
    )

    await expect(controller.deleteExpense('e-other')).rejects.toThrow(/只能修改/)
    expect(ledger.months['2026-10']?.expenses).toHaveLength(1)
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })
})

describe('AppController 分类管理(T8)', () => {
  async function readyController(actor: Member = ADMIN) {
    const api = new FakeApi()
    api.session = sessionOf(actor)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
    })
    await made.controller.boot()
    return made
  }

  it('管理员:新增父/子分类、重命名,写穿本地并同步到端点', async () => {
    const { controller, store, endpoint } = await readyController()

    const parent = await controller.addCategory({ name: ' 咖啡 ' })
    expect(parent).toMatchObject({ name: '咖啡', sortOrder: 10 }) // 预设 10 个父分类
    expect(parent.parentId).toBeUndefined()

    const child = await controller.addCategory({ name: '咖啡豆', parentId: parent.id })
    expect(child).toMatchObject({ name: '咖啡豆', parentId: parent.id, sortOrder: 0 })

    await controller.updateCategory(child.id, { name: '手冲' })
    expect(controller.getLedger().meta.categories.find((c) => c.id === child.id)?.name).toBe('手冲')

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/categories.json']?.content).toContain('手冲')
    expect((await store.loadLedger())?.meta.categories.find((c) => c.id === parent.id)?.name).toBe(
      '咖啡',
    )
  })

  it('设置分类颜色与拖拽排序:写穿本地并同步到端点', async () => {
    const { controller, store, endpoint } = await readyController()

    const parent = await controller.addCategory({ name: '咖啡', color: 'purple' })
    expect(parent.color).toBe('purple')
    await controller.updateCategory(parent.id, { color: 'green' })
    expect(controller.getLedger().meta.categories.find((c) => c.id === parent.id)?.color).toBe(
      'green',
    )

    const parentIds = controller
      .getLedger()
      .meta.categories.filter((c) => c.parentId === undefined)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => c.id)
    const reversed = [...parentIds].reverse()
    await controller.reorderCategories(null, reversed)
    const afterOrder = controller
      .getLedger()
      .meta.categories.filter((c) => c.parentId === undefined)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
      .map((c) => c.id)
    expect(afterOrder).toEqual(reversed)

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/categories.json']?.content).toContain('green')
    const persisted = await store.loadLedger()
    expect(persisted?.meta.categories.find((c) => c.id === parent.id)?.color).toBe('green')
  })

  it('排序列表与同级分类不一致时被拒,账本顺序不变', async () => {
    const { controller } = await readyController()
    const parentIds = controller
      .getLedger()
      .meta.categories.filter((c) => c.parentId === undefined)
      .map((c) => c.id)

    await expect(controller.reorderCategories(null, parentIds.slice(0, 2))).rejects.toMatchObject({
      code: 'category_reorder_mismatch',
    })
    const order = controller
      .getLedger()
      .meta.categories.filter((c) => c.parentId === undefined)
      .map((c) => c.id)
    expect(order).toEqual(parentIds)
  })

  it('删除有支出的子分类:未指定迁移目标被拒;指定同父子分类后支出迁移并登记墓碑', async () => {
    const { controller, store } = await readyController()
    await controller.recordExpense({
      amountText: '12',
      parentId: 'cat-dining',
      categoryId: 'cat-dining-2',
      date: '2026-10-02',
      note: '',
      tagsText: '',
      memberId: '',
    })

    await expect(controller.deleteCategory('cat-dining-2')).rejects.toMatchObject({
      code: 'category_in_use',
    })
    expect(controller.getLedger().meta.categories.some((c) => c.id === 'cat-dining-2')).toBe(true)

    await controller.deleteCategory('cat-dining-2', 'cat-dining-3')

    expect(controller.getLedger().meta.categories.some((c) => c.id === 'cat-dining-2')).toBe(false)
    expect(controller.getLedger().months['2026-10']?.expenses[0]?.categoryId).toBe('cat-dining-3')
    await expect(store.loadQueueOps()).resolves.toEqual([
      { type: 'delete-category', id: 'cat-dining-2' },
    ])
  })

  it('删除有子分类的父分类被拒(category_has_children),账本不变', async () => {
    const { controller } = await readyController()

    await expect(controller.deleteCategory('cat-dining')).rejects.toMatchObject({
      code: 'category_has_children',
    })
    expect(controller.getLedger().meta.categories.some((c) => c.id === 'cat-dining')).toBe(true)
  })

  it('同级重名被拒(category_duplicated)', async () => {
    const { controller } = await readyController()
    const parent = await controller.addCategory({ name: '咖啡' })

    await expect(controller.addCategory({ name: '咖啡' })).rejects.toMatchObject({
      code: 'category_duplicated',
    })
    await controller.addCategory({ name: '拿铁', parentId: parent.id })
    await expect(
      controller.addCategory({ name: '拿铁', parentId: parent.id }),
    ).rejects.toMatchObject({ code: 'category_duplicated' })
    // 不同父下可同名
    await expect(
      controller.addCategory({ name: '拿铁', parentId: 'cat-dining' }),
    ).resolves.toMatchObject({ name: '拿铁' })
  })

  it('普通成员:分类写操作被领域层拒绝,账本与队列不变', async () => {
    const { controller, store } = await readyController(XIAOHONG)

    await expect(controller.addCategory({ name: '咖啡' })).rejects.toThrow(/仅管理员/)
    await expect(controller.updateCategory('cat-dining', { name: '吃饭' })).rejects.toThrow(
      /仅管理员/,
    )
    await expect(controller.deleteCategory('cat-dining-2')).rejects.toThrow(/仅管理员/)
    expect(controller.getLedger().meta.categories.some((c) => c.name === '咖啡')).toBe(false)
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })
})

describe('AppController 预算(T11)', () => {
  async function readyController(actor: Member = ADMIN) {
    const api = new FakeApi()
    api.session = sessionOf(actor)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
    })
    await made.controller.boot()
    return made
  }

  it('管理员设置总预算与分类预算:写穿本地并同步到 budgets.json', async () => {
    const { controller, store, endpoint } = await readyController()

    await controller.setBudget('2026-10', { totalCents: 300000 })
    await controller.setBudget('2026-10', { categoryId: 'cat-dining-2', categoryCents: 50000 })

    expect(controller.getLedger().meta.budgets['2026-10']).toEqual({
      totalCents: 300000,
      categoryCents: { 'cat-dining-2': 50000 },
    })
    expect((await store.loadLedger())?.meta.budgets['2026-10']?.totalCents).toBe(300000)

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/budgets.json']?.content).toContain('"totalCents": 300000')
    expect(files['ledger/meta/budgets.json']?.content).toContain('"cat-dining-2": 50000')
  })

  it('清除整月预算:登记 clear-budget 队列,同步后远端清空且队列回落', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    let online = false
    const { controller, store, endpoint } = makeController({
      api,
      isOnline: () => online,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
    })
    await controller.boot()

    await controller.setBudget('2026-10', { totalCents: 300000 })
    await controller.clearBudget('2026-10')

    expect(controller.getLedger().meta.budgets['2026-10']).toBeUndefined()
    await expect(store.loadQueueOps()).resolves.toEqual([
      { type: 'clear-budget', month: '2026-10' },
    ])

    // 恢复联网:replay 回放 clear-budget,远端 budgets.json 清空、队列回落
    online = true
    await controller.retrySync()
    expect((await endpoint.listFiles())['ledger/meta/budgets.json']?.content).toContain(
      '"budgets": {}',
    )
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })

  it('普通成员设置/清除预算被领域层拒绝,账本与队列不变', async () => {
    const { controller, store } = await readyController(XIAOHONG)

    await expect(controller.setBudget('2026-10', { totalCents: 100000 })).rejects.toThrow(
      /仅管理员/,
    )
    await expect(
      controller.setBudget('2026-10', { categoryId: 'cat-dining-2', categoryCents: 10000 }),
    ).rejects.toThrow(/仅管理员/)
    await expect(controller.clearBudget('2026-10')).rejects.toThrow(/仅管理员/)

    expect(controller.getLedger().meta.budgets).toEqual({})
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })

  it('非法金额与月份格式被拒绝', async () => {
    const { controller } = await readyController()

    await expect(controller.setBudget('2026-10', { totalCents: 0 })).rejects.toMatchObject({
      code: 'invalid_amount',
    })
    await expect(controller.setBudget('2026-13', { totalCents: 100 })).rejects.toMatchObject({
      code: 'invalid_month',
    })
    await expect(
      controller.setBudget('2026-10', { categoryId: 'cat-dining', categoryCents: 100 }),
    ).rejects.toMatchObject({ code: 'category_not_leaf' })
  })
})

describe('AppController 周期支出(T12)', () => {
  async function readyController(actor: Member = ADMIN, newId?: () => string) {
    const api = new FakeApi()
    api.session = sessionOf(actor)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      today: () => '2026-10-02',
      newId,
    })
    await made.controller.boot()
    return made
  }

  it('创建规则后自动补记错过的期次:确定性 id、幂等并推送到远端', async () => {
    const { controller, store, endpoint } = await readyController(ADMIN, () => 'r-fixed')

    const created = await controller.addRecurring({
      amountCents: 300000,
      categoryId: 'cat-housing-1',
      frequency: 'monthly',
      startDate: '2026-08-31',
      note: '房租',
    })
    expect(created).toMatchObject({
      id: 'r-fixed',
      memberId: ADMIN.id,
      createdBy: ADMIN.id,
      enabled: true,
    })

    await controller.retrySync()
    const ledger = controller.getLedger()
    expect(ledger.months['2026-08']?.expenses[0]).toMatchObject({
      id: 'rec-r-fixed-2026-08-31',
      amountCents: 300000,
      note: '房租',
      memberId: ADMIN.id,
    })
    expect(ledger.months['2026-09']?.expenses[0]?.id).toBe('rec-r-fixed-2026-09-30')
    expect(ledger.months['2026-10']).toBeUndefined() // 10 月 31 日尚未到期

    // 再同步一轮:幂等,不重复补记
    await controller.retrySync()
    expect(ledger.months['2026-08']?.expenses).toHaveLength(1)
    expect(ledger.months['2026-09']?.expenses).toHaveLength(1)

    const files = await endpoint.listFiles()
    expect(files['ledger/meta/recurring.json']?.content).toContain('"r-fixed"')
    expect(files['ledger/months/2026-08.json']?.content).toContain('rec-r-fixed-2026-08-31')
    expect((await store.loadLedger())?.months['2026-08']?.expenses).toHaveLength(1)
  })

  it('旧周期表单的 tagNames 保存时补建实体并转为 tagIds(评审修复)', async () => {
    const { controller } = await readyController(ADMIN, () => 'r-legacy')

    const created = await controller.addRecurring({
      amountCents: 1000,
      categoryId: 'cat-dining-2',
      tagNames: ['微信'],
      frequency: 'monthly',
      startDate: '2026-11-01',
    })

    const wechat = await tagIdFromName('微信')
    const cash = await tagIdFromName('现金')
    expect(created.tagIds).toEqual([wechat])
    expect(created.tagNames).toEqual([])
    expect(controller.getLedger().meta.tags).toEqual([
      { id: wechat, name: '微信', updatedAt: '2026-10-02T08:30:00.000Z' },
    ])

    await controller.updateRecurring('r-legacy', { tagNames: ['现金'] })
    const rule = controller.getLedger().meta.recurring[0]
    expect(rule?.tagIds).toEqual([cash])
    expect(rule?.tagNames).toEqual([])
  })

  it('打开应用即补记缓存账本中错过的期次(无需先手动同步)', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const store = new MemoryLocalStore()
    const seed = fixtureLedger()
    seed.meta.recurring = [
      {
        id: 'r-rent',
        amountCents: 200000,
        categoryId: LUNCH_CATEGORY,
        tagNames: [],
        memberId: ADMIN.id,
        frequency: 'monthly',
        startDate: '2026-09-01',
        enabled: true,
        createdBy: ADMIN.id,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]
    await store.saveLedger(seed)
    const { controller } = makeController({
      api,
      store,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      today: () => '2026-10-02',
    })

    await controller.boot()

    expect(controller.getLedger().months['2026-09']?.expenses[0]?.id).toBe('rec-r-rent-2026-09-01')
    expect(controller.getLedger().months['2026-10']?.expenses[0]?.id).toBe('rec-r-rent-2026-10-01')
  })

  it('删除规则登记 delete-recurring 墓碑;恢复联网后远端规则清空且队列回落', async () => {
    const api = new FakeApi()
    api.session = sessionOf(XIAOHONG)
    api.members = [ADMIN, XIAOHONG]
    let online = false
    const store = new MemoryLocalStore()
    await store.saveLedger(fixtureLedger())
    const { controller, endpoint } = makeController({
      api,
      store,
      isOnline: () => online,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      today: () => '2026-10-02',
      newId: () => 'r-mine',
    })
    await controller.boot()

    const created = await controller.addRecurring({
      amountCents: 1000,
      categoryId: 'cat-dining-2',
      frequency: 'weekly',
      startDate: '2026-10-01',
    })
    expect(created.createdBy).toBe(XIAOHONG.id)
    await controller.updateRecurring('r-mine', { enabled: false })
    expect(controller.getLedger().meta.recurring[0]?.enabled).toBe(false)

    await controller.removeRecurring('r-mine')
    expect(controller.getLedger().meta.recurring).toEqual([])
    await expect(store.loadQueueOps()).resolves.toEqual([
      { type: 'delete-recurring', id: 'r-mine', deletedAt: '2026-10-02T08:30:00.000Z' },
    ])

    online = true
    await controller.retrySync()
    expect((await endpoint.listFiles())['ledger/meta/recurring.json']?.content).toContain(
      '"recurring": []',
    )
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })
})

describe('AppController 成员管理(T9)', () => {
  async function readyController(actor: Member = ADMIN) {
    const api = new FakeApi()
    api.session = sessionOf(actor)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({ api })
    await made.controller.boot()
    return { ...made, api }
  }

  it('管理员创建成员:返回公开成员并刷新列表(记一笔经手人可见)', async () => {
    const { controller, api } = await readyController()

    const created = await controller.createMember({
      username: 'dali',
      displayName: '大力',
      password: 'pw-123456',
    })

    expect(created).toMatchObject({
      id: 'id-dali',
      username: 'dali',
      displayName: '大力',
      role: 'member',
      disabled: false,
    })
    expect(created).not.toHaveProperty('passwordHash')
    expect(controller.getState().members.map((m) => m.username)).toEqual([
      'aming',
      'xiaohong',
      'dali',
    ])
    expect(api.members.some((m) => m.username === 'dali')).toBe(true)
  })

  it('管理员可按角色创建;停用/启用成员后列表状态同步刷新', async () => {
    const { controller, api } = await readyController()
    const created = await controller.createMember({
      username: 'guanli',
      displayName: '管理二号',
      password: 'pw-123456',
      role: 'admin',
    })
    expect(created.role).toBe('admin')

    const disabled = await controller.setMemberStatus(created.id, true)
    expect(disabled.disabled).toBe(true)
    expect(controller.getState().members.find((m) => m.id === created.id)?.disabled).toBe(true)
    expect(api.statusCalls).toEqual([{ memberId: created.id, disabled: true }])

    await controller.setMemberStatus(created.id, false)
    expect(controller.getState().members.find((m) => m.id === created.id)?.disabled).toBe(false)
  })

  it('重置密码透传 memberId 与新密码', async () => {
    const { controller, api } = await readyController()

    await controller.resetMemberPassword(XIAOHONG.id, 'new-pw-123')

    expect(api.resetCalls).toEqual([{ memberId: XIAOHONG.id, newPassword: 'new-pw-123' }])
  })

  it('普通成员调用成员管理被拒(forbidden),不触达 API', async () => {
    const { controller, api } = await readyController(XIAOHONG)

    await expect(
      controller.createMember({ username: 'dali', displayName: '大力', password: 'pw-123456' }),
    ).rejects.toThrow(/仅管理员/)
    await expect(controller.setMemberStatus(ADMIN.id, true)).rejects.toThrow(/仅管理员/)
    await expect(controller.resetMemberPassword(ADMIN.id, 'pw-123456')).rejects.toThrow(/仅管理员/)
    expect(api.statusCalls).toEqual([])
    expect(api.resetCalls).toEqual([])
    expect(api.members.some((m) => m.username === 'dali')).toBe(false)
  })

  it('服务端错误(如用户名重复 409)原样抛出', async () => {
    const { controller, api } = await readyController()
    api.createMemberError = new ApiError(409, 'member_duplicated', '用户名已存在')

    await expect(
      controller.createMember({ username: 'aming', displayName: '重复', password: 'pw-123456' }),
    ).rejects.toMatchObject({ status: 409, code: 'member_duplicated' })
  })
})

describe('AppController 标签与标签组管理(V6)', () => {
  async function readyController(
    actor: Member = ADMIN,
    newId?: () => string,
    isOnline?: () => boolean,
  ) {
    const api = new FakeApi()
    api.session = sessionOf(actor)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-02T08:30:00.000Z'),
      newId,
      isOnline,
    })
    await made.controller.boot()
    return made
  }

  const taggedForm = {
    amountText: '12.5',
    parentId: 'cat-dining',
    categoryId: 'cat-dining-2',
    date: '2026-10-02',
    note: '',
    tagsText: '微信, 现金',
    memberId: '',
  }

  it('成员新建/改名标签:写穿本地并同步到 tags.json', async () => {
    const { controller, store, endpoint } = await readyController(XIAOHONG)

    const tag = await controller.addTag(' 微信 ')
    expect(tag).toMatchObject({ id: await tagIdFromName('微信'), name: '微信' })
    await controller.renameTag(tag.id, '支付宝')
    expect(controller.getLedger().meta.tags[0]?.name).toBe('支付宝')
    expect((await store.loadLedger())?.meta.tags[0]?.name).toBe('支付宝')

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/tags.json']?.content).toContain('支付宝')
  })

  it('删除标签:清理支出引用、登记 delete-tag 墓碑,同步后远端引用一并清理', async () => {
    let online = true
    const { controller, store, endpoint } = await readyController(ADMIN, undefined, () => online)
    await controller.recordExpense(taggedForm)
    await controller.retrySync()
    const wechat = await tagIdFromName('微信')
    expect(controller.tagUsageCount(wechat)).toBe(1)

    // 离线删除:本地立即生效并登记墓碑;恢复联网后 replay 一并清理远端引用
    online = false
    await controller.deleteTag(wechat)
    online = true

    expect(controller.getLedger().meta.tags.map((t) => t.name)).toEqual(['现金'])
    expect(controller.getLedger().months['2026-10']?.expenses[0]?.tagIds).toEqual([
      await tagIdFromName('现金'),
    ])
    await expect(store.loadQueueOps()).resolves.toEqual([{ type: 'delete-tag', id: wechat }])

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/tags.json']?.content).not.toContain('微信')
    expect(files['ledger/months/2026-10.json']?.content).not.toContain(wechat)
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })

  it('tagUsageCount:按支出笔数统计(删除确认文案用)', async () => {
    const { controller } = await readyController()
    await expect(controller.recordExpense(taggedForm)).resolves.toBeDefined()
    const wechat = await tagIdFromName('微信')
    const cash = await tagIdFromName('现金')

    expect(controller.tagUsageCount(wechat)).toBe(1)
    expect(controller.tagUsageCount(cash)).toBe(1)
    expect(controller.tagUsageCount('tag-missing')).toBe(0)
  })

  it('普通成员:标签可写,标签组管理被领域层拒绝且不登记队列', async () => {
    const { controller, store } = await readyController(XIAOHONG)

    await expect(controller.addTagGroup({ name: '支付方式', color: 'blue' })).rejects.toThrow(
      /仅管理员/,
    )
    await expect(controller.updateTagGroup('grp-1', { color: 'red' })).rejects.toThrow(/仅管理员/)
    await expect(controller.deleteTagGroup('grp-1')).rejects.toThrow(/仅管理员/)
    await expect(controller.reorderTagGroups(['grp-1'])).rejects.toThrow(/仅管理员/)
    expect(controller.getLedger().meta.tagGroups).toEqual([])
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })

  it('管理员建组/改组/排序/删组:队列登记墓碑并在同步后落远端', async () => {
    let seq = 0
    const { controller, store, endpoint } = await readyController(ADMIN, () => `fixed-${++seq}`)
    const wx = await controller.addTag('微信')
    const cash = await controller.addTag('现金')

    const first = await controller.addTagGroup({ name: '支付方式', color: 'blue', tagIds: [wx.id] })
    const second = await controller.addTagGroup({ name: '场景', color: 'green' })
    expect(first).toMatchObject({ id: 'grp-fixed-1', sortOrder: 0 })
    expect(second).toMatchObject({ id: 'grp-fixed-2', sortOrder: 1 })

    await controller.updateTagGroup(second.id, {
      tagIds: [cash.id],
      singleSelect: true,
      required: true,
    })
    expect(controller.getLedger().meta.tagGroups[1]).toMatchObject({
      tagIds: [cash.id],
      singleSelect: true,
      required: true,
    })

    await controller.reorderTagGroups([second.id, first.id])
    expect(controller.getLedger().meta.tagGroups.map((g) => [g.id, g.sortOrder])).toEqual([
      ['grp-fixed-1', 1],
      ['grp-fixed-2', 0],
    ])

    await controller.deleteTagGroup(first.id)
    await expect(store.loadQueueOps()).resolves.toEqual([
      { type: 'delete-tag-group', id: 'grp-fixed-1' },
    ])

    await controller.retrySync()
    const files = await endpoint.listFiles()
    expect(files['ledger/meta/tagGroups.json']?.content).not.toContain('grp-fixed-1')
    expect(files['ledger/meta/tagGroups.json']?.content).toContain('grp-fixed-2')
    await expect(store.loadQueueOps()).resolves.toEqual([])
  })

  it('回归(#29):旧组缺 sortOrder 时新建组仍排最后', async () => {
    const { controller } = await readyController(ADMIN, () => 'fixed-new')
    // 旧数据(V6 之前落库的组)没有 sortOrder 字段
    controller.getLedger().meta.tagGroups = [
      { id: 'grp-legacy-1', name: '旧一', color: 'blue', tagIds: [] },
      { id: 'grp-legacy-2', name: '旧二', color: 'red', tagIds: [] },
    ]

    const created = await controller.addTagGroup({ name: '新组', color: 'gray' })

    expect(created).toMatchObject({ id: 'grp-fixed-new', sortOrder: 1 })
    expect(sortedTagGroups(controller.getLedger().meta.tagGroups).map((group) => group.id)).toEqual(
      ['grp-legacy-1', 'grp-legacy-2', 'grp-fixed-new'],
    )
  })
})

describe('AppController 编辑器写入(V7)', () => {
  async function readyController(newId: () => string) {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const made = makeController({
      api,
      now: () => new Date('2026-10-03T08:30:00.000Z'),
      newId,
    })
    await made.controller.boot()
    return made
  }

  it('addExpense 直写 tagIds:改名后的标签仍按实体 id 命中(不经过名字派生)', async () => {
    let seq = 0
    const { controller, store, endpoint } = await readyController(() => `e-${++seq}`)
    const wechat = await controller.addTag('微信')
    await controller.renameTag(wechat.id, '支付宝')

    const created = await controller.addExpense({
      amountCents: 1500,
      date: '2026-10-03',
      categoryId: 'cat-dining-1',
      tagIds: [wechat.id],
      note: '午饭',
    })

    expect(created).toMatchObject({ id: 'e-1', amountCents: 1500, tagIds: [wechat.id] })
    expect(controller.getLedger().meta.tags[0]?.name).toBe('支付宝')
    expect((await store.loadLedger())?.months['2026-10']?.expenses[0]?.tagIds).toEqual([wechat.id])

    await controller.retrySync()
    expect((await endpoint.listFiles())['ledger/months/2026-10.json']?.content).toContain(wechat.id)
  })

  it('patchExpense:金额/标签/备注整体替换,写穿并同步', async () => {
    const { controller, store } = await readyController(() => 'e-1')
    const tag = await controller.addTag('现金')
    await controller.addExpense({
      amountCents: 1000,
      date: '2026-10-03',
      categoryId: 'cat-dining-1',
      tagIds: [],
      note: '旧备注',
    })

    await controller.patchExpense('e-1', {
      amountCents: 2500,
      tagIds: [tag.id],
      note: null,
    })

    const updated = controller.getLedger().months['2026-10']?.expenses[0]
    expect(updated).toMatchObject({ amountCents: 2500, tagIds: [tag.id] })
    expect(updated?.note).toBeUndefined()
    expect((await store.loadLedger())?.months['2026-10']?.expenses[0]?.amountCents).toBe(2500)
  })
})

describe('AppController 修改密码(T13)', () => {
  it('登录成员透传当前密码与新密码;服务端错误原样抛出', async () => {
    const api = new FakeApi()
    api.session = sessionOf(ADMIN)
    api.members = [ADMIN, XIAOHONG]
    const { controller } = makeController({ api })
    await controller.boot()

    await controller.changePassword('old-pw', 'new-pw-123')
    expect(api.changePasswordCalls).toEqual([
      { currentPassword: 'old-pw', newPassword: 'new-pw-123' },
    ])

    api.changePasswordError = new ApiError(401, 'wrong_password', '当前密码错误')
    await expect(controller.changePassword('bad', 'new-pw-123')).rejects.toMatchObject({
      status: 401,
      code: 'wrong_password',
    })
    expect(controller.getState().phase).toBe('ready')
  })
})
