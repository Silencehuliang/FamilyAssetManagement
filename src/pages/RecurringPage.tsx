import { useState } from 'react'
import { toast } from 'sonner'
import MdiArrowLeft from '~icons/mdi/arrow-left'
import MdiDeleteOutline from '~icons/mdi/delete-outline'
import MdiPauseCircleOutline from '~icons/mdi/pause-circle-outline'
import MdiPencilOutline from '~icons/mdi/pencil-outline'
import MdiPlayCircleOutline from '~icons/mdi/play-circle-outline'
import MdiPlus from '~icons/mdi/plus'
import { PopupLayout, useConfirm, useDialog } from '../components/dialog'
import {
  canEditRecurring,
  FREQUENCIES,
  FREQUENCY_LABELS,
  type Frequency,
  nextDueDate,
  type RecurringExpense,
} from '../domain'
import { formatAmountInput } from '../features/entries'
import {
  formatCents,
  groupCategories,
  parseAmountToCents,
  resolveCategoryPath,
  todayKey,
} from '../features/entry'
import { errorText } from '../lib/errors'
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
 * 周期支出(T12):规则列表(金额/分类/频率/下次到期/启用状态)与创建/编辑对话框。
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
  const { showDialog } = useDialog()
  const confirm = useConfirm()

  const [busy, setBusy] = useState(false)

  const rules = [...ledger.meta.recurring].sort((a, b) =>
    a.startDate === b.startDate ? (a.id < b.id ? -1 : 1) : a.startDate < b.startDate ? 1 : -1,
  )
  const members = (
    state.members.length > 0 ? state.members : state.member ? [state.member] : []
  ).filter((member) => !member.disabled)

  const openForm = (rule: RecurringExpense | null): void => {
    const initial: RuleForm =
      rule === null
        ? {
            amountText: '',
            parentId: '',
            categoryId: '',
            frequency: 'monthly',
            startDate: today,
            endDate: '',
            note: '',
            memberId: actor?.id ?? '',
          }
        : ruleToForm(ledger, rule)
    const memberOptions =
      rule === null || members.some((member) => member.id === rule.memberId)
        ? members
        : [...members, ...ledger.meta.members.filter((member) => member.id === rule.memberId)]
    void showDialog<void>(
      ({ close }) => (
        <RecurringFormDialog
          controller={controller}
          ledger={ledger}
          members={memberOptions}
          ruleId={rule?.id ?? null}
          initial={initial}
          onClose={() => close(undefined)}
        />
      ),
      { label: rule === null ? '新建周期支出' : '编辑周期支出' },
    )
  }

  const toggle = (rule: RecurringExpense): void => {
    setBusy(true)
    void controller
      .updateRecurring(rule.id, { enabled: !rule.enabled })
      .then(() => {
        toast.success(rule.enabled ? '已停用,不再补记' : '已启用')
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const remove = (rule: RecurringExpense): void => {
    void confirm('删除该周期支出规则?已补记的支出会保留。', {
      title: '删除周期支出',
      confirmText: '删除',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void controller
        .removeRecurring(rule.id)
        .then(() => {
          toast.success('规则已删除,已补记的支出保留')
        })
        .catch((err: unknown) => {
          toast.error(errorText(err))
        })
        .finally(() => {
          setBusy(false)
        })
    })
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
        <h2 className="card-title">周期支出</h2>
        <p className="member-meta">
          按周期自动补记支出(房租、订阅等)。打开应用或同步后补记到期的期次,补记的支出备注为
          「周期支出」,可正常编辑或删除;停用后不再补记。
        </p>
      </section>

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
                    className="text-button inline-flex items-center gap-0.5"
                    disabled={!editable || busy}
                    onClick={() => toggle(rule)}
                  >
                    {rule.enabled ? (
                      <MdiPauseCircleOutline className="size-4" />
                    ) : (
                      <MdiPlayCircleOutline className="size-4" />
                    )}
                    {rule.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="text-button inline-flex items-center gap-0.5"
                    disabled={!editable || busy}
                    onClick={() => openForm(rule)}
                  >
                    <MdiPencilOutline className="size-4" />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="text-button danger-text inline-flex items-center gap-0.5"
                    disabled={!editable || busy}
                    onClick={() => remove(rule)}
                  >
                    <MdiDeleteOutline className="size-4" />
                    删除
                  </button>
                </div>
              </div>
            </section>
          )
        })
      )}

      <button
        type="button"
        className="primary-button inline-flex items-center justify-center gap-1"
        disabled={busy}
        onClick={() => openForm(null)}
      >
        <MdiPlus className="size-4" />
        新建周期支出
      </button>
    </div>
  )
}

/** 周期规则创建/编辑对话框:成功 toast 并关闭 */
function RecurringFormDialog({
  controller,
  ledger,
  members,
  ruleId,
  initial,
  onClose,
}: {
  controller: AppController
  ledger: AppState['ledger']
  members: AppState['members']
  ruleId: string | null
  initial: RuleForm
  onClose: () => void
}) {
  const [values, setValues] = useState<RuleForm>(initial)
  const [busy, setBusy] = useState(false)

  const save = (resolved: { categoryId: string; memberId: string }): void => {
    let amountCents: number
    try {
      amountCents = parseAmountToCents(values.amountText)
    } catch (err) {
      toast.error(errorText(err))
      return
    }
    const note = values.note.trim()
    const endDate = values.endDate.trim()
    const base = {
      amountCents,
      categoryId: resolved.categoryId,
      memberId: resolved.memberId,
      frequency: values.frequency,
      startDate: values.startDate,
    }
    setBusy(true)
    const run =
      ruleId === null
        ? controller.addRecurring({
            ...base,
            note: note === '' ? undefined : note,
            endDate: endDate === '' ? undefined : endDate,
          })
        : controller.updateRecurring(ruleId, {
            ...base,
            note: note === '' ? null : note,
            endDate: endDate === '' ? null : endDate,
          })
    void run
      .then(() => {
        toast.success(
          ruleId === null ? '周期支出已创建,到期会自动补记' : '规则已更新,仅影响之后的期次',
        )
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
    <PopupLayout title={ruleId === null ? '新建周期支出' : '编辑周期支出'}>
      <RuleFormFields
        ledger={ledger}
        members={members}
        values={values}
        onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
        onSubmit={save}
        submitting={busy}
        submitLabel={ruleId === null ? '创建规则' : '保存修改'}
      />
    </PopupLayout>
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
          // biome-ignore lint/a11y/noAutofocus: 对话框唯一主输入,自动聚焦是刻意行为
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
