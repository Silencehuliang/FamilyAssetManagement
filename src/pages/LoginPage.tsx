import { type FormEvent, useState } from 'react'
import type { AppController, AppState } from '../state/app-controller'

/** 登录页:用户名 + 密码 → POST /api/login;会话持久化在客户端 API 层 */
export function LoginPage({ controller, state }: { controller: AppController; state: AppState }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const canSubmit = username.trim() !== '' && password !== '' && !state.busy

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    void controller.submitLogin({ username: username.trim(), password })
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">家庭记账</h1>
        <p className="auth-subtitle">用家人给你的账号登录</p>
        <form onSubmit={onSubmit}>
          <label className="field">
            <span>用户名</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="如 xiaohong"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {state.authError ? <p className="form-error">{state.authError}</p> : null}
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {state.busy ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
