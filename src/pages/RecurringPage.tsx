import { useState } from 'react'
import {
  canEditRecurring,
  FREQUENCIES,
  FREQUENCY_LABELS,
  type Frequency,
  nextDueDate,
  type RecurringExpense,
} from '../domain'
import { DomainError } from '../domain/types'
import { formatAmountInput } from '../features/entries'
import {
  formatCents,
  groupCategories,
  parseAmountToCents,
  resolveCategoryPath,
  todayKey,
} from '../features/entry'
import type { AppController, AppState } from '../state/app-controller'

interface RuleForm {
  amountText: string
  parentId: string
  categoryId: string
  frequency: Frequency
  startDate: string
  endDate: string
  note: string
  memberId: string
}

interface Feedback {
  kind: 'ok' | 'error'
  text: string
}

function errorText(err: unknown): string {
  if (err instanceof DomainError || err instanceof Error) return err.message
  return '操作失败,请重试'
}

function ruleToForm(ledger: AppState['ledger'], rule: RecurringExpense): RuleForm {
  const category = ledger.meta.categories.find((item) => item.id === rule.categoryId)
  return {
    amountText: formatAmountInput(rule.amountCents),
    parentId: category?.parentId ?? '',
    categoryId: rule.categoryId,
    frequency: rule.frequency,
    startDate: rule.startDate,
    endDate: rule.endDate ?? '',
    note: rule.note ?? '',
    memberId: rule.memberId,
  }
}

/**
 * 周期支出(T12):规则列表(金额/分类/频率/下次到期/启用状态)与创建/编辑弹层。
 * 任何启用成员可创建;编辑/删除仅限创建者、经手人与管理员。
 * 补记在打开应用与每轮同步后自动完成,这里只维护规则。
 */
export function RecurringPage({
  controller,
  state,
  onBack,
}: {
  controller: AppController
  state: AppState
  onBack: () => void
}) {
  const ledger = state.ledger
  const actor = state.member
  const today = todayKey()

  const [editing, setEditing] = useState<{ id: string | null; values: RuleForm } | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)

  const rules = [...ledger.meta.recurring].sort((a, b) =>
    a.startDate === b.startDate ? (a.id < b.id ? -1 : 1) : a.startDate < b.startDate ? 1 : -1,
  )
  const members = (
    state.members.length > 0 ? state.members : state.member ? [state.member] : []
  ).filter((member) => !member.disabled || member.id === editing?.values.memberId)

  const openCreate = (): void => {
    setFeedback(null)
    setEditing({
      id: null,
      values: {
        amountText: '',
        parentId: '',
        categoryId: '',
        frequency: 'monthly',
        startDate: today,
        endDate: '',
        note: '',
        memberId: actor?.id ?? '',
      },
    })
  }

  const openEdit = (rule: RecurringExpense): void => {
    setFeedback(null)
    setEditing({ id: rule.id, values: ruleToForm(ledger, rule) })
  }

  const run = (task: Promise<unknown>, okText: string): void => {
    setBusy(true)
    setFeedback(null)
    void task
      .then(() => {
        setEditing(null)
        setFeedback({ kind: 'ok', text: okText })
      })
      .catch((err: unknown) => {
        setFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const save = (resolved: { categoryId: string; memberId: string }): void => {
    if (!editing) return
    let amountCents: number
    try {
      amountCents = parseAmountToCents(editing.values.amountText)
    } catch (err) {
      setFeedback({ kind: 'error', text: errorText(err) })
      return
    }
    const note = editing.values.note.trim()
    const endDate = editing.values.endDate.trim()
    const base = {
      amountCents,
      categoryId: resolved.categoryId,
      memberId: resolved.memberId,
      frequency: editing.values.frequency,
      startDate: editing.values.startDate,
    }
    if (editing.id === null) {
      run(
        controller.addRecurring({
          ...base,
          note: note === '' ? undefined : note,
          endDate: endDate === '' ? undefined : endDate,
        }),
        '周期支出已创建,到期会自动补记',
      )
    } else {
      run(
        controller.updateRecurring(editing.id, {
          ...base,
          note: note === '' ? null : note,
          endDate: endDate === '' ? null : endDate,
        }),
        '规则已更新,仅影响之后的期次',
      )
    }
  }

  const toggle = (rule: RecurringExpense): void => {
    run(
      controller.updateRecurring(rule.id, { enabled: !rule.enabled }),
      rule.enabled ? '已停用,不再补记' : '已启用',
    )
  }

  const remove = (rule: RecurringExpense): void => {
    if (!window.confirm('删除该周期支出规则?已补记的支出会保留。')) return
    run(controller.removeRecurring(rule.id), '规则已删除,已补记的支出保留')
  }

  return (
    <div className="page">
      <button type="button" className="link-button back-button" onClick={onBack}>
        ← 返回
      </button>

      <section className="card">
        <h2 className="card-title">周期支出</h2>
        <p className="member-meta">
          按周期自动补记支出(房租、订阅等)。打开应用或同步后补记到期的期次,补记的支出备注为
          「周期支出」,可正常编辑或删除;停用后不再补记。
        </p>
      </section>

      {feedback ? (
        <p className={feedback.kind === 'ok' ? 'form-success' : 'form-error'}>{feedback.text}</p>
      ) : null}

      {rules.length === 0 ? (
        <section className="placeholder-card">
          <p className="placeholder-title">还没有周期支出</p>
          <p className="placeholder-note">创建一条规则,房租、会员费就不用月月手记了。</p>
        </section>
      ) : (
        rules.map((rule) => {
          const editable = actor ? canEditRecurring(actor, rule) : false
          const next = nextDueDate(rule, today)
          const member = ledger.meta.members.find((item) => item.id === rule.memberId)
          return (
            <section className="card" key={rule.id}>
              <div className="category-row">
                <div className="recurring-main">
                  <p className="recurring-amount">{formatCents(rule.amountCents)}</p>
                  <p className="member-meta">
                    {resolveCategoryPath(ledger, rule.categoryId)} ·{' '}
                    {FREQUENCY_LABELS[rule.frequency]} · 经手人 {member?.displayName ?? '未知成员'}
                  </p>
                  <p className="member-meta">
                    {rule.enabled ? `下次:${next ?? '无(已到达结束日期)'}` : '已停用,不再补记'}
                    {rule.endDate ? ` · 截止 ${rule.endDate}` : ''}
                  </p>
                  {rule.note ? <p className="member-meta">备注:{rule.note}</p> : null}
                </div>
                <div className="row-actions recurring-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={!editable || busy}
                    onClick={() => toggle(rule)}
                  >
                    {rule.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!editable || busy}
                    onClick={() => openEdit(rule)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="text-button danger-text"
                    disabled={!editable || busy}
                    onClick={() => remove(rule)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </section>
          )
        })
      )}

      <button type="button" className="primary-button" disabled={busy} onClick={openCreate}>
        + 新建周期支出
      </button>

      {editing ? (
        <div className="sheet-backdrop">
          <section className="sheet" aria-label="周期支出规则">
            <div className="sheet-header">
              <h2 className="card-title">
                {editing.id === null ? '新建周期支出' : '编辑周期支出'}
              </h2>
              <button
                type="button"
                className="link-button sheet-close"
                onClick={() => setEditing(null)}
              >
                关闭
              </button>
            </div>
            <RuleFormFields
              ledger={ledger}
              members={members}
              values={editing.values}
              onChange={(patch) =>
                setEditing((current) =>
                  current ? { ...current, values: { ...current.values, ...patch } } : current,
                )
              }
              onSubmit={save}
              submitting={busy}
              submitLabel={editing.id === null ? '创建规则' : '保存修改'}
            />
          </section>
        </div>
      ) : null}
    </div>
  )
}

function RuleFormFields({
  ledger,
  members,
  values,
  onChange,
  onSubmit,
  submitting,
  submitLabel,
}: {
  ledger: AppState['ledger']
  members: AppState['members']
  values: RuleForm
  onChange: (patch: Partial<RuleForm>) => void
  onSubmit: (resolved: { categoryId: string; memberId: string }) => void
  submitting: boolean
  submitLabel: string
}) {
  const { parents, childrenByParent } = groupCategories(ledger.meta.categories)
  const parent = parents.find((item) => item.id === values.parentId) ?? parents[0]
  const children = parent ? (childrenByParent[parent.id] ?? []) : []
  const child = children.find((item) => item.id === values.categoryId) ?? children[0]
  const member = members.find((item) => item.id === values.memberId) ?? members[0]
  const canSubmit =
    values.amountText.trim() !== '' && child !== undefined && member !== undefined && !submitting

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit || !child || !member) return
        onSubmit({ categoryId: child.id, memberId: member.id })
      }}
    >
      <label className="field amount-field">
        <span>金额(元)</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: 弹层唯一主输入,自动聚焦是刻意行为
          autoFocus
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={values.amountText}
          onChange={(event) => onChange({ amountText: event.target.value })}
        />
      </label>

      <fieldset className="field category-field">
        <legend>分类(子分类)</legend>
        <div className="chip-row">
          {parents.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${parent?.id === item.id ? 'chip-active' : ''}`}
              aria-pressed={parent?.id === item.id}
              onClick={() => onChange({ parentId: item.id, categoryId: '' })}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="chip-row chip-row-child">
          {children.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${child?.id === item.id ? 'chip-active' : ''}`}
              aria-pressed={child?.id === item.id}
              onClick={() => onChange({ categoryId: item.id })}
            >
              {item.name}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span>频率</span>
        <select
          value={values.frequency}
          onChange={(event) => onChange({ frequency: event.target.value as Frequency })}
        >
          {FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {FREQUENCY_LABELS[frequency]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>起始日期</span>
        <input
          type="date"
          value={values.startDate}
          onChange={(event) => onChange({ startDate: event.target.value })}
        />
      </label>

      <label className="field">
        <span>结束日期(可选,留空表示长期)</span>
        <input
          type="date"
          value={values.endDate}
          onChange={(event) => onChange({ endDate: event.target.value })}
        />
      </label>

      <label className="field">
        <span>经手人</span>
        <select
          value={member?.id ?? ''}
          onChange={(event) => onChange({ memberId: event.target.value })}
        >
          {members.map((item) => (
            <option key={item.id} value={item.id}>
              {item.displayName}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>备注(可选)</span>
        <input
          type="text"
          placeholder="留空时补记备注为「周期支出」"
          value={values.note}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </label>

      <button type="submit" className="primary-button" disabled={!canSubmit}>
        {submitting ? '保存中…' : submitLabel}
      </button>
    </form>
  )
}
