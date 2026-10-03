import { useState } from 'react'
import { toast } from 'sonner'
import MdiAccountCheckOutline from '~icons/mdi/account-check-outline'
import MdiAccountOffOutline from '~icons/mdi/account-off-outline'
import MdiAccountPlusOutline from '~icons/mdi/account-plus-outline'
import MdiArrowLeft from '~icons/mdi/arrow-left'
import MdiLockReset from '~icons/mdi/lock-reset'
import { PopupLayout, useConfirm, useDialog } from '../components/dialog'
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
  const { showDialog } = useDialog()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)

  const openCreate = (): void => {
    void showDialog<void>(
      ({ close }) => (
        <CreateMemberDialog controller={controller} onClose={() => close(undefined)} />
      ),
      { label: '创建成员' },
    )
  }

  const openReset = (member: Member): void => {
    void showDialog<void>(
      ({ close }) => (
        <ResetPasswordDialog
          controller={controller}
          member={member}
          onClose={() => close(undefined)}
        />
      ),
      { label: `重置「${member.displayName}」的密码` },
    )
  }

  const toggleStatus = (member: Member): void => {
    const next = !member.disabled
    void (async () => {
      if (next) {
        const ok = await confirm(`停用「${member.displayName}」?停用后其登录与同步会被拒绝。`, {
          title: '停用成员',
          confirmText: '停用',
          danger: true,
        })
        if (!ok) return
      }
      setBusy(true)
      void controller
        .setMemberStatus(member.id, next)
        .then(() => {
          toast.success(next ? '已停用该成员' : '已启用该成员')
        })
        .catch((err: unknown) => {
          toast.error(errorText(err))
        })
        .finally(() => {
          setBusy(false)
        })
    })()
  }

  if (!isAdmin) {
    return (
      <div className="page">
        <button
          type="button"
          className="link-button back-button inline-flex items-center gap-1"
          onClick={onBack}
        >
          <MdiArrowLeft className="size-4" />
          返回
        </button>
        <section className="placeholder-card">
          <p className="placeholder-title">仅管理员可管理成员</p>
          <p className="placeholder-note">如需调整账户,请联系家庭管理员。</p>
        </section>
      </div>
    )
  }

  return (
    <div className="page">
      <button
        type="button"
        className="link-button back-button inline-flex items-center gap-1"
        onClick={onBack}
      >
        <MdiArrowLeft className="size-4" />
        返回
      </button>

      <section className="card">
        <h2 className="card-title">成员管理</h2>
        <p className="member-meta">
          成员即登录账户;停用后该成员的登录与同步立即被拒绝,重新启用后恢复。
        </p>
      </section>

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
                className="text-button inline-flex items-center gap-0.5"
                disabled={busy || (member.id === state.member?.id && !member.disabled)}
                onClick={() => toggleStatus(member)}
              >
                {member.disabled ? (
                  <MdiAccountCheckOutline className="size-4" />
                ) : (
                  <MdiAccountOffOutline className="size-4" />
                )}
                {member.disabled ? '启用' : '停用'}
              </button>
              <button
                type="button"
                className="text-button inline-flex items-center gap-0.5"
                disabled={busy}
                onClick={() => openReset(member)}
              >
                <MdiLockReset className="size-4" />
                重置密码
              </button>
            </div>
          </div>
        </section>
      ))}

      <button
        type="button"
        className="primary-button inline-flex items-center justify-center gap-1"
        disabled={busy}
        onClick={openCreate}
      >
        <MdiAccountPlusOutline className="size-4" />
        创建成员
      </button>
    </div>
  )
}

/** 创建成员表单(对话框):成功后 toast 并关闭 */
function CreateMemberDialog({
  controller,
  onClose,
}: {
  controller: AppController
  onClose: () => void
}) {
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE)
  const [busy, setBusy] = useState(false)
  const canCreate =
    form.username.trim() !== '' && form.displayName.trim() !== '' && form.password !== '' && !busy

  const submit = (): void => {
    setBusy(true)
    void controller
      .createMember({
        username: form.username,
        displayName: form.displayName,
        password: form.password,
      })
      .then(() => {
        toast.success('成员已创建,可以登录记一笔了')
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <PopupLayout title="创建成员">
      <label className="field">
        <span>用户名(登录用)</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: 对话框唯一主输入,自动聚焦是刻意行为
          autoFocus
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
      <button type="button" className="primary-button" disabled={!canCreate} onClick={submit}>
        {busy ? '处理中…' : '创建成员'}
      </button>
    </PopupLayout>
  )
}

/** 管理员重置成员密码 */
function ResetPasswordDialog({
  controller,
  member,
  onClose,
}: {
  controller: AppController
  member: Member
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    setBusy(true)
    void controller
      .resetMemberPassword(member.id, password)
      .then(() => {
        toast.success(`已重置「${member.displayName}」的密码`)
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <PopupLayout title={`重置「${member.displayName}」的密码`}>
      <label className="field">
        <span>新密码</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: 对话框唯一输入,自动聚焦是刻意行为
          autoFocus
          type="password"
          value={password}
          placeholder="设置后请告知该成员"
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={password === '' || busy}
        onClick={submit}
      >
        {busy ? '处理中…' : '确认重置'}
      </button>
    </PopupLayout>
  )
}
