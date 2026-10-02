import { type FormEvent, useState } from 'react'
import type { AppController, AppState } from '../state/app-controller'

/** 初始化向导:仓库尚无 members.json 时创建管理员 → POST /api/setup → 自动登录 */
export function SetupPage({ controller, state }: { controller: AppController; state: AppState }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [confirmError, setConfirmError] = useState<string>()

  const canSubmit =
    username.trim() !== '' &&
    displayName.trim() !== '' &&
    password !== '' &&
    confirm !== '' &&
    !state.busy

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    if (password !== confirm) {
      setConfirmError('两次输入的密码不一致')
      return
    }
    setConfirmError(undefined)
    void controller.submitSetup({
      username: username.trim(),
      displayName: displayName.trim(),
      password,
    })
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">初始化家庭账本</h1>
        <p className="auth-subtitle">
          第一次使用,请创建管理员账户。账本数据存放在你自己的 GitHub 仓库中。
        </p>
        <form onSubmit={onSubmit}>
          <label className="field">
            <span>用户名</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用于登录,如 admin"
            />
          </label>
          <label className="field">
            <span>显示名</span>
            <input
              type="text"
              name="displayName"
              autoComplete="nickname"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="家人看到的名字,如 阿明"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>确认密码</span>
            <input
              type="password"
              name="confirm"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          {confirmError || state.authError ? (
            <p className="form-error">{confirmError ?? state.authError}</p>
          ) : null}
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {state.busy ? '创建中…' : '创建管理员并进入'}
          </button>
        </form>
        <button type="button" className="link-button" onClick={() => controller.goToLogin()}>
          已有账户?直接登录
        </button>
      </div>
    </div>
  )
}
