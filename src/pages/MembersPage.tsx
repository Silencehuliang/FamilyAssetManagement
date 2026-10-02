import { useState } from 'react'
import type { Member } from '../domain'
import { DomainError } from '../domain/types'
import type { AppController, AppState } from '../state/app-controller'

interface CreateForm {
  username: string
  displayName: string
  password: string
}

const EMPTY_CREATE: CreateForm = { username: '', displayName: '', password: '' }

function errorText(err: unknown): string {
  if (err instanceof DomainError || err instanceof Error) return err.message
  return '操作失败,请重试'
}

/**
 * 成员管理(T9,仅管理员):创建成员、停用/启用、重置密码。
 * 变更成功后经 AppController 刷新成员列表,记一笔的经手人选择器即时更新;
 * 停用成员的旧会话在下一次同步/请求即被服务端拒绝。
 * 普通成员直接访问此页显示无权限(入口本身也不可见)。
 */
export function MembersPage({
  controller,
  state,
  onBack,
}: {
  controller: AppController
  state: AppState
  onBack: () => void
}) {
  const isAdmin = state.member?.role === 'admin'
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE)
  const [resetTarget, setResetTarget] = useState<Member | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = (task: Promise<unknown>, okText: string, onDone?: () => void): void => {
    setBusy(true)
    setFeedback(null)
    void task
      .then(() => {
        setFeedback({ kind: 'ok', text: okText })
        onDone?.()
      })
      .catch((err: unknown) => {
        setFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const submitCreate = (): void => {
    run(
      controller.createMember({
        username: form.username,
        displayName: form.displayName,
        password: form.password,
      }),
      '成员已创建,可以登录记一笔了',
      () => setForm(EMPTY_CREATE),
    )
  }

  const toggleStatus = (member: Member): void => {
    const next = !member.disabled
    if (next && !window.confirm(`停用「${member.displayName}」?停用后其登录与同步会被拒绝。`)) {
      return
    }
    run(controller.setMemberStatus(member.id, next), next ? '已停用该成员' : '已启用该成员')
  }

  const submitReset = (): void => {
    if (!resetTarget) return
    run(
      controller.resetMemberPassword(resetTarget.id, resetPassword),
      `已重置「${resetTarget.displayName}」的密码`,
      () => {
        setResetTarget(null)
        setResetPassword('')
      },
    )
  }

  if (!isAdmin) {
    return (
      <div className="page">
        <button type="button" className="link-button back-button" onClick={onBack}>
          ← 返回
        </button>
        <section className="placeholder-card">
          <p className="placeholder-title">仅管理员可管理成员</p>
          <p className="placeholder-note">如需调整账户,请联系家庭管理员。</p>
        </section>
      </div>
    )
  }

  const canCreate =
    form.username.trim() !== '' && form.displayName.trim() !== '' && form.password !== '' && !busy

  return (
    <div className="page">
      <button type="button" className="link-button back-button" onClick={onBack}>
        ← 返回
      </button>

      <section className="card">
        <h2 className="card-title">成员管理</h2>
        <p className="member-meta">
          成员即登录账户;停用后该成员的登录与同步立即被拒绝,重新启用后恢复。
        </p>
      </section>

      {feedback ? (
        <p className={feedback.kind === 'ok' ? 'form-success' : 'form-error'}>{feedback.text}</p>
      ) : null}

      {state.members.map((member) => (
        <section className="card" key={member.id}>
          <div className="category-row">
            <div>
              <p className="member-name">
                {member.displayName}
                {member.id === state.member?.id ? <span className="member-meta">(我)</span> : null}
              </p>
              <p className="member-meta">
                @{member.username} · {member.role === 'admin' ? '管理员' : '成员'} ·{' '}
                {member.disabled ? '已停用' : '启用中'}
              </p>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy || (member.id === state.member?.id && !member.disabled)}
                onClick={() => toggleStatus(member)}
              >
                {member.disabled ? '启用' : '停用'}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setResetTarget(member)
                  setResetPassword('')
                  setFeedback(null)
                }}
              >
                重置密码
              </button>
            </div>
          </div>
        </section>
      ))}

      <section className="card">
        <h2 className="card-title">创建成员</h2>
        <label className="field">
          <span>用户名(登录用)</span>
          <input
            type="text"
            value={form.username}
            placeholder="如 dali"
            onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
          />
        </label>
        <label className="field">
          <span>显示名</span>
          <input
            type="text"
            value={form.displayName}
            placeholder="如 大力"
            onChange={(event) => setForm((f) => ({ ...f, displayName: event.target.value }))}
          />
        </label>
        <label className="field">
          <span>初始密码</span>
          <input
            type="password"
            value={form.password}
            placeholder="交给成员后请尽快修改"
            onChange={(event) => setForm((f) => ({ ...f, password: event.target.value }))}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={!canCreate}
          onClick={submitCreate}
        >
          {busy ? '处理中…' : '创建成员'}
        </button>
      </section>

      {resetTarget ? (
        <div className="sheet-backdrop">
          <section className="sheet" aria-label="重置密码">
            <h2 className="card-title">重置「{resetTarget.displayName}」的密码</h2>
            <label className="field">
              <span>新密码</span>
              <input
                type="password"
                value={resetPassword}
                placeholder="设置后请告知该成员"
                onChange={(event) => setResetPassword(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={resetPassword === '' || busy}
              onClick={submitReset}
            >
              {busy ? '处理中…' : '确认重置'}
            </button>
            <button type="button" className="link-button" onClick={() => setResetTarget(null)}>
              取消
            </button>
          </section>
        </div>
      ) : null}
    </div>
  )
}
