import { SYNC_LABELS } from '../components/SyncBadge'
import type { AppController, AppState } from '../state/app-controller'

/** 我的:当前成员、角色、分类管理入口、同步状态与手动重试、登出 */
export function MePage({
  controller,
  state,
  onOpenCategories,
}: {
  controller: AppController
  state: AppState
  onOpenCategories: () => void
}) {
  const member = state.member
  return (
    <div className="page">
      <section className="card">
        <h2 className="card-title">当前账户</h2>
        <p className="member-name">{member?.displayName ?? '未登录'}</p>
        <p className="member-meta">
          @{member?.username} · {member?.role === 'admin' ? '管理员' : '成员'}
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">账本设置</h2>
        <button type="button" className="primary-button" onClick={onOpenCategories}>
          分类管理
        </button>
      </section>

      <section className="card">
        <h2 className="card-title">数据同步</h2>
        <p className="member-meta">
          状态:{SYNC_LABELS[state.syncStatus]}
          {state.syncStatus === 'error' && state.syncError ? `(${state.syncError})` : ''}
        </p>
        <p className="member-meta">账本数据同步到家庭自己的 GitHub 私有仓库,离线也能记账。</p>
        <button
          type="button"
          className="primary-button"
          disabled={state.syncStatus === 'syncing'}
          onClick={() => void controller.retrySync()}
        >
          {state.syncStatus === 'syncing' ? '同步中…' : '立即同步'}
        </button>
      </section>

      <section className="card">
        <button type="button" className="danger-button" onClick={() => controller.logout()}>
          退出登录
        </button>
      </section>
    </div>
  )
}
