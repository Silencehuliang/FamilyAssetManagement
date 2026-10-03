import type { ReactNode } from 'react'
import type { Category, Member } from '../domain'
import { groupCategories } from '../features/entry'

/** 记一笔表单的受控值(新增与编辑共用) */
export interface ExpenseFormValues {
  /** 用户输入的金额文本(元) */
  amountText: string
  parentId: string
  categoryId: string
  /** YYYY-MM-DD */
  date: string
  note: string
  /** 逗号/顿号/空格分隔的标签 */
  tagsText: string
  memberId: string
}

interface ExpenseFormProps {
  /** 可选分类;新增页在没有账本分类时传入默认分类 */ categories: Category[]
  /** 可选经手人(通常只列启用成员;编辑时需包含原经手人) */
  members: Member[]
  currentMemberId?: string
  values: ExpenseFormValues
  onChange: (patch: Partial<ExpenseFormValues>) => void
  /** 提交时回传落位后的分类与经手人(未显式选择时取首个可选项) */
  onSubmit: (resolved: { categoryId: string; memberId: string }) => void
  submitLabel: string
  submitting?: boolean
  autoFocusAmount?: boolean
  /** 表单底部追加的自定义操作(如编辑态的删除按钮) */
  footer?: ReactNode
}

/**
 * 记一笔 / 编辑支出的共享表单(T7 抽取):金额 + 两级分类 + 日期 + 经手人 + 备注 + 标签。
 * 纯受控组件:分类与成员的落位由调用方保证(编辑时由 expenseToForm 回填)。
 */
export function ExpenseForm({
  categories,
  members,
  currentMemberId,
  values,
  onChange,
  onSubmit,
  submitLabel,
  submitting = false,
  autoFocusAmount = false,
  footer,
}: ExpenseFormProps) {
  const { parents, childrenByParent } = groupCategories(categories)
  const parent = parents.find((p) => p.id === values.parentId) ?? parents[0]
  const children = parent ? (childrenByParent[parent.id] ?? []) : []
  const child = children.find((c) => c.id === values.categoryId) ?? children[0]
  const member = members.find((m) => m.id === values.memberId) ?? members[0]

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
          // biome-ignore lint/a11y/noAutofocus: 记一笔是首页主任务,聚焦金额是刻意行为
          autoFocus={autoFocusAmount}
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={values.amountText}
          onChange={(event) => onChange({ amountText: event.target.value })}
        />
      </label>

      <fieldset className="field category-field">
        <legend>分类</legend>
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
        <span>日期</span>
        <input
          type="date"
          value={values.date}
          onChange={(event) => onChange({ date: event.target.value })}
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
              {item.id === currentMemberId ? '(我)' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>备注(可选)</span>
        <input
          type="text"
          placeholder="如 楼下超市"
          value={values.note}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </label>

      <label className="field">
        <span>标签(可选,逗号分隔)</span>
        <input
          type="text"
          placeholder="如 微信, 日用"
          value={values.tagsText}
          onChange={(event) => onChange({ tagsText: event.target.value })}
        />
      </label>

      <button type="submit" className="primary-button" disabled={!canSubmit}>
        {submitting ? '保存中…' : submitLabel}
      </button>

      {footer}
    </form>
  )
}
