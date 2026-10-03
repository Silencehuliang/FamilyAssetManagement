import type { ComponentType } from 'react'
import { useState } from 'react'
import MdiAccountGroupOutline from '~icons/mdi/account-group-outline'
import MdiCalendarSyncOutline from '~icons/mdi/calendar-sync-outline'
import MdiChevronRight from '~icons/mdi/chevron-right'
import MdiCogOutline from '~icons/mdi/cog-outline'
import MdiLogoutVariant from '~icons/mdi/logout-variant'
import MdiShapeOutline from '~icons/mdi/shape-outline'
import MdiThemeLightDark from '~icons/mdi/theme-light-dark'
import { SYNC_LABELS } from '../components/SyncBadge'
import { type ThemeChoice, useTheme } from '../components/theme'
import type { AppController, AppState } from '../state/app-controller'

interface Feedback {
  kind: 'ok' | 'error'
  text: string
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return '操作失败,请重试'
}

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function SettingRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-t border-border bg-transparent py-3 text-left text-[15px] text-foreground first:border-t-0"
    >
      <Icon className="size-5 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      <MdiChevronRight className="size-5 text-muted-foreground" />
    </button>
  )
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
  const { theme, setTheme } = useTheme()
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
        <h2 className="card-title flex items-center gap-1.5">
          <MdiCogOutline className="size-4" />
          账本设置
        </h2>
        <div className="flex flex-col">
          <SettingRow icon={MdiCalendarSyncOutline} label="周期支出" onClick={onOpenRecurring} />
          <SettingRow icon={MdiShapeOutline} label="分类管理" onClick={onOpenCategories} />
          {member?.role === 'admin' ? (
            <SettingRow icon={MdiAccountGroupOutline} label="成员管理" onClick={onOpenMembers} />
          ) : null}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">外观</h2>
        <div className="chip-row">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`chip ${theme === option.value ? 'chip-active' : ''}`}
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="member-meta flex items-center gap-1">
          <MdiThemeLightDark className="size-4" />
          深色模式跟随 .dark class,改动即时生效。
        </p>
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
        <button
          type="button"
          className="danger-button inline-flex items-center justify-center gap-1.5"
          onClick={() => controller.logout()}
        >
          <MdiLogoutVariant className="size-4" />
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
