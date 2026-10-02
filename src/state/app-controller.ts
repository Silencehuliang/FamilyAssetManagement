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
import type {
  AuthResult,
  ChangePasswordInput,
  CreateMemberInput,
  LedgerApi,
  LoginInput,
  ResetPasswordInput,
  SetMemberStatusInput,
  SetupInput,
  StoredSession,
} from '../api'
import { ApiError } from '../api/client'
import {
  addCategory as addCategoryInLedger,
  addExpense,
  addRecurring as addRecurringInLedger,
  type BudgetPatch,
  type Category,
  type CategoryId,
  clearBudget as clearBudgetInLedger,
  createEmptyLedger,
  deleteCategory as deleteCategoryInLedger,
  deleteExpense as deleteExpenseInLedger,
  type Expense,
  type ExpenseId,
  generateDueExpenses,
  type LedgerData,
  type Member,
  type MonthKey,
  type RecurringExpense,
  type RecurringId,
  type RecurringInput,
  type RecurringPatch,
  removeRecurring as removeRecurringInLedger,
  setCategoryBudget as setCategoryBudgetInLedger,
  setTotalBudget as setTotalBudgetInLedger,
  updateCategory as updateCategoryInLedger,
  updateExpense as updateExpenseInLedger,
  updateRecurring as updateRecurringInLedger,
} from '../domain'
import { DomainError } from '../domain/types'
import { nextSortOrder } from '../features/categories'
import {
  buildExpenseInput,
  buildExpensePatch,
  type EntryForm,
  ensureCategories,
  todayKey,
} from '../features/entry'
import type { LocalStore } from '../storage'
import { MemoryLocalStore, PersistentQueue } from '../storage'
import type { PendingOp, SyncEndpoint } from '../sync'
import { createRemoteEndpoint } from '../sync'
import { SyncManager, type SyncStatus } from './sync'

export type AppPhase = 'booting' | 'setup' | 'login' | 'ready'

/** 控制器依赖的 API 面:rest 接口 + 会话读写 + 成员管理(T9;ApiClient 结构化满足) */
export interface AppApi extends LedgerApi {
  getSession(): StoredSession | null
  clearSession(): void
  setOnUnauthorized?(handler: () => void): void
  createMember(input: CreateMemberInput): Promise<Member>
  setMemberStatus(input: SetMemberStatusInput): Promise<Member>
  resetMemberPassword(input: ResetPasswordInput): Promise<Member>
  changePassword(input: ChangePasswordInput): Promise<Member>
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
  /** 本地「今天」(YYYY-MM-DD);测试注入,缺省取本机日期 */
  today?: () => string
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
      onSynced: () => this.handleSynced(),
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

  /**
   * 设置/修改月度预算(T11,仅管理员;领域层二次门禁):
   * patch.totalCents 设置总预算、null 清除;categoryId + categoryCents 设置/清除分类预算。
   * 本地生效 → 写穿 IndexedDB → 后台同步(budgets.json 由管理员推送,成员端只拉)。
   */
  async setBudget(month: MonthKey, patch: BudgetPatch): Promise<void> {
    const actor = this.currentActor()
    if (patch.totalCents !== undefined) {
      setTotalBudgetInLedger(this.ledger, actor, month, patch.totalCents)
    }
    if (patch.categoryId !== undefined) {
      setCategoryBudgetInLedger(
        this.ledger,
        actor,
        month,
        patch.categoryId,
        patch.categoryCents ?? null,
      )
    }
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  /**
   * 清除整月预算(T11,仅管理员):本地删除并登记 clear-budget 离线操作,
   * 由 replay 在同步时补删远端,防止其他设备的旧预算被合并回来。
   */
  async clearBudget(month: MonthKey): Promise<void> {
    const actor = this.currentActor()
    clearBudgetInLedger(this.ledger, actor, month)
    this.queue.record({ type: 'clear-budget', month })
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  /**
   * 新增周期支出规则(T12):任何启用成员可创建,createdBy 为创建者;
   * 保存后台同步,补记由 enterApp/每轮同步后的 materializeRecurring 完成。
   */
  async addRecurring(input: RecurringInput): Promise<RecurringExpense> {
    const actor = this.currentActor()
    const id = this.generateId()
    addRecurringInLedger(this.ledger, input, { actor, now: this.nowIso(), newId: id })
    const created = this.ledger.meta.recurring.find((rule) => rule.id === id)
    if (!created) throw new Error('新增周期支出后未找到规则')
    await this.persistLedger()
    void this.syncManager?.syncNow()
    return created
  }

  /**
   * 修改周期支出规则(T12,创建者/经手人/管理员):只影响之后的期次,
   * 已生成的支出因确定性 id 命中而保留原值。
   */
  async updateRecurring(id: RecurringId, patch: RecurringPatch): Promise<void> {
    const actor = this.currentActor()
    updateRecurringInLedger(this.ledger, id, patch, {
      actor,
      now: this.nowIso(),
      newId: this.generateId(),
    })
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  /** 删除周期支出规则(T12):登记 delete-recurring 离线墓碑;已生成的支出保留 */
  async removeRecurring(id: RecurringId): Promise<void> {
    const actor = this.currentActor()
    const now = this.nowIso()
    removeRecurringInLedger(this.ledger, id, { actor, now, newId: this.generateId() })
    this.queue.record({ type: 'delete-recurring', id, deletedAt: now })
    await this.persistLedger()
    void this.syncManager?.syncNow()
  }

  /**
   * 创建成员(T9,仅管理员):成功后刷新成员列表,记一笔的经手人选择立即更新。
   */
  async createMember(input: CreateMemberInput): Promise<Member> {
    this.assertAdmin()
    const created = await this.deps.api.createMember(input)
    await this.refreshMembers(created)
    return created
  }

  /**
   * 停用/启用成员(T9,仅管理员):服务端停用后该成员旧会话的同步与请求随即被拒;
   * 成功后刷新成员列表(停用成员从经手人选择中消失/恢复)。
   */
  async setMemberStatus(memberId: string, disabled: boolean): Promise<Member> {
    this.assertAdmin()
    const updated = await this.deps.api.setMemberStatus({ memberId, disabled })
    await this.refreshMembers(updated)
    return updated
  }

  /** 重置成员密码(T9,仅管理员) */
  async resetMemberPassword(memberId: string, newPassword: string): Promise<void> {
    this.assertAdmin()
    await this.deps.api.resetMemberPassword({ memberId, newPassword })
  }

  /**
   * 修改自己的密码(T13):当前密码由服务端校验(错误时抛 401 wrong_password,
   * 客户端保留了会话);成功后旧密码即失效,当前会话不受影响。
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (!this.state.member) throw new DomainError('unauthorized', '未登录')
    await this.deps.api.changePassword({ currentPassword, newPassword })
  }

  private assertAdmin(): void {
    if (this.state.member?.role !== 'admin') {
      throw new DomainError('forbidden', '仅管理员可管理成员')
    }
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
    // 打开应用先补记周期支出(离线也会本地生成;确定性 id 让联网后的合并幂等收敛)
    await this.materializeRecurring()
    await this.syncManager?.syncNow()
  }

  /**
   * 一轮同步成功后的收尾:写穿账本 → 补记周期支出;若补记产生新支出,
   * 再触发一轮同步把它们推给其他设备(SyncManager 会合并为补跑轮次,自然收敛)。
   */
  private async handleSynced(): Promise<void> {
    await this.persistLedger()
    if (await this.materializeRecurring()) {
      void this.syncManager?.syncNow()
    }
  }

  /** 周期支出补记(T12,幂等);返回本轮是否产生新支出 */
  private async materializeRecurring(): Promise<boolean> {
    try {
      const { generated } = generateDueExpenses(this.ledger, this.today(), this.nowIso())
      if (generated === 0) return false
      await this.persistLedger()
      return true
    } catch (err) {
      // 规则数据异常不应阻断同步主流程:跳过本次补记,下次同步再试
      console.error('周期支出补记失败', err)
      return false
    }
  }

  private today(): string {
    return (this.deps.today ?? (() => todayKey()))()
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
