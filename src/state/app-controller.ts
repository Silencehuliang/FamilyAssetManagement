/**
 * 应用控制器(T5):把启动、登录/初始化、本地持久化与同步编排组装成
 * React 无关的状态机。界面只订阅状态并调用方法,便于对流程做逻辑测试。
 *
 * 启动流程:
 * 1. hydrate IndexedDB(账本快照 + 离线队列 + 成员缓存);
 * 2. 有会话 → 拉取成员并进入主界面(网络失败则离线用缓存);
 * 3. 无会话 → GET /api/members 探测:members_file_missing → 初始化向导,401 → 登录页;
 * 4. 进入主界面后立即跑一轮 replay(queue, local, remote)。
 */
import type { AuthResult, LedgerApi, LoginInput, SetupInput, StoredSession } from '../api'
import { ApiError } from '../api/client'
import {
  addCategory as addCategoryInLedger,
  addExpense,
  type Category,
  type CategoryId,
  createEmptyLedger,
  deleteCategory as deleteCategoryInLedger,
  deleteExpense as deleteExpenseInLedger,
  type Expense,
  type ExpenseId,
  type LedgerData,
  type Member,
  type MonthKey,
  updateCategory as updateCategoryInLedger,
  updateExpense as updateExpenseInLedger,
} from '../domain'
import { DomainError } from '../domain/types'
import { nextSortOrder } from '../features/categories'
import {
  buildExpenseInput,
  buildExpensePatch,
  type EntryForm,
  ensureCategories,
} from '../features/entry'
import type { LocalStore } from '../storage'
import { MemoryLocalStore, PersistentQueue } from '../storage'
import type { PendingOp, SyncEndpoint } from '../sync'
import { createRemoteEndpoint } from '../sync'
import { SyncManager, type SyncStatus } from './sync'

export type AppPhase = 'booting' | 'setup' | 'login' | 'ready'

/** 控制器依赖的 API 面:rest 接口 + 会话读写(ApiClient 结构化满足) */
export interface AppApi extends LedgerApi {
  getSession(): StoredSession | null
  clearSession(): void
  setOnUnauthorized?(handler: () => void): void
}

export interface AppState {
  phase: AppPhase
  /** 当前登录成员 */
  member: Member | null
  /** 本地账本(浅拷贝快照;每次变更后替换引用触发渲染) */
  ledger: LedgerData
  /** 已加载的成员列表(与 ledger.meta.members 同步) */
  members: Member[]
  syncStatus: SyncStatus
  syncError?: string
  authError?: string
  busy: boolean
}

export interface AppControllerDeps {
  api: AppApi
  store: LocalStore
  /** 默认由 api 组装远端端点;测试可注入 */
  endpoint?: SyncEndpoint
  isOnline?: () => boolean
  now?: () => Date
  newId?: () => string
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return '操作失败,请重试'
}

export class AppController {
  private readonly deps: AppControllerDeps
  private ledger: LedgerData = createEmptyLedger()
  private queue: PersistentQueue
  private syncManager: SyncManager | null = null
  private booted = false
  private state: AppState = {
    phase: 'booting',
    member: null,
    ledger: this.ledger,
    members: [],
    syncStatus: 'offline',
    busy: false,
  }
  private readonly listeners = new Set<() => void>()
  /** 本地存储;IndexedDB 不可用时退化为内存实现 */
  private store: LocalStore

  constructor(deps: AppControllerDeps) {
    this.deps = deps
    this.store = deps.store
    this.queue = new PersistentQueue(this.store)
    deps.api.setOnUnauthorized?.(() => this.handleUnauthorized())
  }

  getState = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前账本(部件读取;随每次变更被原地更新) */
  getLedger(): LedgerData {
    return this.ledger
  }

  getSyncManager(): SyncManager | null {
    return this.syncManager
  }

  async boot(): Promise<void> {
    if (this.booted) return
    this.booted = true
    try {
      const cachedLedger = await this.store.loadLedger()
      if (cachedLedger) this.ledger = cachedLedger
      const cachedMembers = await this.store.loadMembers()
      if (cachedMembers && this.ledger.meta.members.length === 0) {
        this.ledger.meta.members = cachedMembers
      }
      this.queue = await PersistentQueue.hydrate(this.store)
    } catch (err) {
      // IndexedDB 不可用(隐私模式/受限环境):退化为内存存储,应用可用但不再跨刷新保留
      console.error('本地存储不可用,退化为内存模式', err)
      this.store = new MemoryLocalStore()
      this.queue = new PersistentQueue(this.store)
    }
    this.syncManager = new SyncManager({
      endpoint: this.deps.endpoint ?? createRemoteEndpoint(this.deps.api),
      queue: this.queue,
      ledger: this.ledger,
      getRole: () => this.deps.api.getSession()?.member.role,
      isOnline: this.deps.isOnline,
      onStatus: (status, error) => this.setState({ syncStatus: status, syncError: error }),
      onSynced: () => this.persistLedger(),
    })
    this.setState({ ledger: { ...this.ledger }, members: [...this.ledger.meta.members] })

    const session = this.deps.api.getSession()
    if (session) {
      await this.enterApp(session)
      return
    }
    await this.decideEntry()
  }

  async submitSetup(input: SetupInput): Promise<void> {
    this.setState({ busy: true, authError: undefined })
    try {
      const session = await this.deps.api.setup(input)
      await this.enterApp(session)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'setup_already_done') {
        this.setState({ phase: 'login', authError: '账本已完成初始化,请直接登录' })
      } else {
        this.setState({ authError: errorText(err) })
      }
    } finally {
      this.setState({ busy: false })
    }
  }

  async submitLogin(input: LoginInput): Promise<void> {
    this.setState({ busy: true, authError: undefined })
    try {
      const session = await this.deps.api.login(input)
      await this.enterApp(session)
    } catch (err) {
      this.setState({ authError: errorText(err) })
    } finally {
      this.setState({ busy: false })
    }
  }

  /** 登出:清会话回登录页;保留本地账本缓存(家庭共享设备,重新登录即可继续) */
  logout(): void {
    this.deps.api.clearSession()
    this.setState({ phase: 'login', member: null, authError: undefined })
  }

  /** 初始化向导 → 登录页(已有账户时) */
  goToLogin(): void {
    this.setState({ phase: 'login', authError: undefined })
  }

  /** 手动重试同步(我的页按钮/在线事件);未登录时不发请求 */
  async retrySync(): Promise<void> {
    if (this.state.phase !== 'ready') return
    await this.syncManager?.syncNow()
  }

  /** 登记一条离线删除(领域层已应用变更后由调用方登记) */
  queueOp(op: PendingOp): void {
    this.queue.record(op)
  }

  /**
   * 记一笔:表单 → 领域输入 → addExpense(本地即时生效)→ 写穿 IndexedDB →
   * 触发一轮同步(不阻塞界面,状态徽标随 SyncManager 变化)。
   */
  async recordExpense(form: EntryForm): Promise<Expense> {
    ensureCategories(this.ledger)
    const actor = this.currentActor()
    const input = buildExpenseInput(this.ledger, form, actor.id)
    const now = this.nowIso()
    const newId = this.generateId()
    addExpense(this.ledger, input, { actor, now, newId })

    const month = input.date.slice(0, 7)
    const created = this.ledger.months[month]?.expenses.find((e) => e.id === newId)
    if (!created) throw new Error('新增支出后未找到记录')

    await this.persistLedger()
    void this.syncManager?.syncNow()
    return created
  }

  /**
   * 修改一笔(明细页编辑):领域层校验「管理员/经手人/记录者」权限,
   * 本地立即生效 → 写穿 IndexedDB → 后台同步(LWW 传播,无需队列)。
   */
  async updateExpense(id: ExpenseId, form: EntryForm): Promise<void> {
    const actor = this.currentActor()
    const patch = buildExpensePatch(this.ledger, form)
    updateExpenseInLedger(this.ledger, id, patch, {
      actor,
      now: this.nowIso(),
      newId: this.generateId(),
    })
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  /**
   * 删除一笔:领域层校验权限后本地删除,并登记离线墓碑(delete-expense),
   * 由 replay 在同步时补删远端,避免其他设备的旧副本把记录推回来。
   */
  async deleteExpense(id: ExpenseId): Promise<void> {
    const actor = this.currentActor()
    const month = this.monthOfExpense(id)
    const now = this.nowIso()
    deleteExpenseInLedger(this.ledger, id, { actor, now, newId: this.generateId() })
    this.queue.record({ type: 'delete-expense', id, month, deletedAt: now })
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  private monthOfExpense(id: ExpenseId): MonthKey {
    for (const [month, data] of Object.entries(this.ledger.months)) {
      if (data.expenses.some((e) => e.id === id)) return month
    }
    throw new DomainError('unknown_expense', `支出不存在:${id}`)
  }

  /**
   * 新增分类(T8,仅管理员;领域层二次门禁):parentId 缺省为父分类,
   * 排序位次取同级最大 + 1,写穿本地并触发同步。
   */
  async addCategory(input: { name: string; parentId?: CategoryId }): Promise<Category> {
    const actor = this.currentActor()
    const name = input.name.trim()
    if (name === '') throw new DomainError('invalid_name', '请输入分类名称')
    const id = `cat-${this.generateId()}`
    addCategoryInLedger(this.ledger, actor, {
      id,
      name,
      parentId: input.parentId,
      sortOrder: nextSortOrder(this.ledger, input.parentId),
    })
    const created = this.ledger.meta.categories.find((c) => c.id === id)
    if (!created) throw new Error('新增分类后未找到记录')
    await this.persistLedger()
    void this.syncManager?.syncNow()
    return created
  }

  /** 重命名分类或调整排序(T8,仅管理员) */
  async updateCategory(
    id: CategoryId,
    patch: { name?: string; sortOrder?: number },
  ): Promise<void> {
    const actor = this.currentActor()
    const next = { ...patch }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (name === '') throw new DomainError('invalid_name', '请输入分类名称')
      next.name = name
    }
    updateCategoryInLedger(this.ledger, actor, id, next)
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  /**
   * 删除分类(T8,仅管理员):有支出的子分类必须传 migrateToId(同父子分类),
   * 支出迁移过去;有子分类的父分类会被领域层拒绝(category_has_children)。
   * 删除经离线队列登记,防止远端旧分类被合并复活。
   */
  async deleteCategory(id: CategoryId, migrateToId?: CategoryId): Promise<void> {
    const actor = this.currentActor()
    deleteCategoryInLedger(this.ledger, actor, id, migrateToId)
    this.queue.record({ type: 'delete-category', id })
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString()
  }

  private generateId(): string {
    return (this.deps.newId ?? (() => crypto.randomUUID()))()
  }

  private currentActor(): Member {
    const member = this.state.member
    if (!member) throw new DomainError('unauthorized', '未登录')
    return this.ledger.meta.members.find((m) => m.id === member.id) ?? member
  }

  /** 把当前账本写穿到 IndexedDB(领域变更后调用) */
  async persistLedger(): Promise<void> {
    await this.store.saveLedger(this.ledger)
    this.touchLedger()
  }

  /** 订阅浏览器在线/离线事件;返回解绑函数(在 React 副作用中调用) */
  startConnectivityListeners(): () => void {
    if (typeof window === 'undefined') return () => {}
    const onOnline = (): void => {
      if (this.state.phase === 'ready') void this.syncManager?.syncNow()
    }
    const onOffline = (): void => {
      this.syncManager?.markOffline()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }

  private async decideEntry(): Promise<void> {
    try {
      const probe = await this.deps.api.probeInitialization()
      this.setState({ phase: probe === 'uninitialized' ? 'setup' : 'login' })
    } catch (err) {
      // 网络失败无法探测:默认登录页,并把原因显示出来
      this.setState({ phase: 'login', authError: errorText(err) })
    }
  }

  private async enterApp(session: AuthResult | StoredSession): Promise<void> {
    this.setState({ phase: 'ready', member: session.member, busy: false })
    await this.refreshMembers(session.member)
    await this.store.saveLedger(this.ledger)
    this.touchLedger()
    await this.syncManager?.syncNow()
  }

  private async refreshMembers(sessionMember: Member): Promise<void> {
    try {
      const members = await this.deps.api.getMembers()
      this.ledger.meta.members = members
      await this.store.saveMembers(members)
      this.setState({ members: [...members] })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // 会话失效:onUnauthorized 已把界面切回登录页
        return
      }
      // 离线:沿用本地缓存成员;没有任何缓存时至少放入当前登录成员
      const cached = await this.store.loadMembers()
      const fallback = cached ?? this.ledger.meta.members
      if (fallback.length > 0) {
        this.ledger.meta.members = fallback
      } else {
        this.ledger.meta.members = [sessionMember]
      }
      this.setState({ members: [...this.ledger.meta.members] })
      this.syncManager?.markOffline()
    }
  }

  private handleUnauthorized(): void {
    this.setState({
      phase: 'login',
      member: null,
      busy: false,
      authError: '会话已过期,请重新登录',
    })
  }

  private touchLedger(): void {
    this.setState({ ledger: { ...this.ledger }, members: [...this.ledger.meta.members] })
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
