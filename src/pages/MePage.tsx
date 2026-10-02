import { useState } from 'react'
import { SYNC_LABELS } from '../components/SyncBadge'
import type { AppController, AppState } from '../state/app-controller'

interface Feedback {
  kind: 'ok' | 'error'
  text: string
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return '操作失败,请重试'
}

/**
 * 我的(T13 打磨):当前成员、分类/成员/周期支出入口、修改密码弹层;
 * 同步状态区分「离线(本地已保存,联网自动同步)」「失败(展示错误 + 重试)」「已同步」。
 */
export function MePage({
  controller,
  state,
  onOpenCategories,
  onOpenMembers,
  onOpenRecurring,
}: {
  controller: AppController
  state: AppState
  onOpenCategories: () => void
  onOpenMembers: () => void
  onOpenRecurring: () => void
}) {
  const member = state.member
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback | null>(null)
  const [notice, setNotice] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)

  const openPasswordSheet = (): void => {
    setPasswordOpen(true)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPasswordFeedback(null)
  }

  const submitPassword = (): void => {
    if (newPassword !== confirmPassword) {
      setPasswordFeedback({ kind: 'error', text: '两次输入的新密码不一致' })
      return
    }
    setBusy(true)
    setPasswordFeedback(null)
    void controller
      .changePassword(currentPassword, newPassword)
      .then(() => {
        setPasswordOpen(false)
        setNotice({ kind: 'ok', text: '密码已修改,下次登录请使用新密码' })
      })
      .catch((err: unknown) => {
        // 当前密码错误等由服务端返回可读文案(401 wrong_password 不会退出登录)
        setPasswordFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const canSubmitPassword =
    currentPassword !== '' && newPassword !== '' && confirmPassword !== '' && !busy

  return (
    <div className="page">
      <section className="card">
        <h2 className="card-title">当前账户</h2>
        <p className="member-name">{member?.displayName ?? '未登录'}</p>
        <p className="member-meta">
          @{member?.username} · {member?.role === 'admin' ? '管理员' : '成员'}
        </p>
        <button type="button" className="primary-button" onClick={openPasswordSheet}>
          修改密码
        </button>
      </section>

      {notice ? (
        <p className={notice.kind === 'ok' ? 'form-success' : 'form-error'}>{notice.text}</p>
      ) : null}

      <section className="card">
        <h2 className="card-title">账本设置</h2>
        <button type="button" className="primary-button" onClick={onOpenRecurring}>
          周期支出
        </button>
        <button type="button" className="primary-button" onClick={onOpenCategories}>
          分类管理
        </button>
        {member?.role === 'admin' ? (
          <button type="button" className="primary-button" onClick={onOpenMembers}>
            成员管理
          </button>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card-title">数据同步</h2>
        <p className="member-meta">状态:{SYNC_LABELS[state.syncStatus]}</p>
        {state.syncStatus === 'error' ? (
          <p className="form-error">
            同步失败{state.syncError ? `:${state.syncError}` : ''}。本地记录不受影响,可重试。
          </p>
        ) : null}
        {state.syncStatus === 'offline' ? (
          <p className="member-meta">离线中:记录已保存在本机,联网后会自动同步。</p>
        ) : null}
        {state.syncStatus === 'synced' ? (
          <p className="member-meta">已同步到家庭仓库;换设备登录同一账户即可看到。</p>
        ) : null}
        <p className="member-meta">账本数据同步到家庭自己的 GitHub 私有仓库,离线也能记账。</p>
        <button
          type="button"
          className="primary-button"
          disabled={state.syncStatus === 'syncing'}
          onClick={() => void controller.retrySync()}
        >
          {state.syncStatus === 'syncing'
            ? '同步中…'
            : state.syncStatus === 'error'
              ? '重试同步'
              : '立即同步'}
        </button>
      </section>

      <section className="card">
        <button type="button" className="danger-button" onClick={() => controller.logout()}>
          退出登录
        </button>
      </section>

      {passwordOpen ? (
        <div className="sheet-backdrop">
          <section className="sheet" aria-label="修改密码">
            <div className="sheet-header">
              <h2 className="card-title">修改密码</h2>
              <button
                type="button"
                className="link-button sheet-close"
                onClick={() => setPasswordOpen(false)}
              >
                关闭
              </button>
            </div>
            <label className="field">
              <span>当前密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>新密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>确认新密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
            {passwordFeedback ? (
              <p className={passwordFeedback.kind === 'ok' ? 'form-success' : 'form-error'}>
                {passwordFeedback.text}
              </p>
            ) : null}
            <button
              type="button"
              className="primary-button"
              disabled={!canSubmitPassword}
              onClick={submitPassword}
            >
              {busy ? '提交中…' : '确认修改'}
            </button>
          </section>
        </div>
      ) : null}
    </div>
  )
}
