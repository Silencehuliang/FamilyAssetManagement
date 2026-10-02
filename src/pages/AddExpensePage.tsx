import { type FormEvent, useState } from 'react'
import { DEFAULT_CATEGORIES, DomainError } from '../domain'
import {
  type EntryForm,
  formatCents,
  groupCategories,
  monthSummary,
  recentExpenses,
  resolveCategoryName,
  todayKey,
} from '../features/entry'
import type { AppController, AppState } from '../state/app-controller'

interface Feedback {
  kind: 'ok' | 'error'
  text: string
}

/**
 * 记一笔(首页):金额 + 子分类两步必填,日期/备注/标签/经手人可后补。
 * 保存走 AppController.recordExpense:本地立即生效、写穿 IndexedDB、后台同步;
 * 保存后保留日期与分类,方便连续记账。
 */
export function AddExpensePage({
  controller,
  state,
}: {
  controller: AppController
  state: AppState
}) {
  const ledger = state.ledger
  const today = todayKey()
  const summary = monthSummary(ledger, today.slice(0, 7), today)
  const recent = recentExpenses(ledger, 5)

  // 账本无分类时展示默认分类(提交前会先播种进本地账本)
  const categories = ledger.meta.categories.length > 0 ? ledger.meta.categories : DEFAULT_CATEGORIES
  const { parents, childrenByParent } = groupCategories(categories)

  const [parentChoice, setParentChoice] = useState('')
  const [childChoice, setChildChoice] = useState('')
  const parent = parents.find((p) => p.id === parentChoice) ?? parents[0]
  const children = parent ? (childrenByParent[parent.id] ?? []) : []
  const child = children.find((c) => c.id === childChoice) ?? children[0]

  // 经手人只列启用成员(停用成员不能记账;登录者本人始终在列)
  const members = (
    state.members.length > 0 ? state.members : state.member ? [state.member] : []
  ).filter((m) => !m.disabled)
  const [memberChoice, setMemberChoice] = useState('')
  const member =
    members.find((m) => m.id === memberChoice) ??
    members.find((m) => m.id === state.member?.id) ??
    members[0]

  const [amountText, setAmountText] = useState('')
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit =
    amountText.trim() !== '' && child !== undefined && member !== undefined && !submitting

  const chooseParent = (parentId: string): void => {
    setParentChoice(parentId)
    setChildChoice('')
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit || !child || !member) return
    setSubmitting(true)
    setFeedback(null)
    const form: EntryForm = {
      amountText,
      parentId: parent?.id ?? '',
      categoryId: child.id,
      date,
      note,
      tagsText,
      memberId: member.id,
    }
    void controller
      .recordExpense(form)
      .then(() => {
        setAmountText('')
        setNote('')
        setTagsText('')
        setFeedback({ kind: 'ok', text: '已记下,可以继续记下一笔' })
      })
      .catch((err: unknown) => {
        setFeedback({
          kind: 'error',
          text:
            err instanceof DomainError || err instanceof Error ? err.message : '保存失败,请重试',
        })
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  return (
    <div className="page">
      <section className="summary-card">
        <div className="summary-item">
          <span className="summary-label">本月累计</span>
          <strong className="summary-value">{formatCents(summary.monthTotalCents)}</strong>
        </div>
        <div className="summary-item">
          <span className="summary-label">今日小计</span>
          <strong className="summary-value">
            {formatCents(summary.todayTotalCents)}
            {summary.todayCount > 0 ? (
              <small className="summary-count">{summary.todayCount} 笔</small>
            ) : null}
          </strong>
        </div>
      </section>

      <form className="card" onSubmit={onSubmit}>
        <label className="field amount-field">
          <span>金额(元)</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: 记一笔是首页主任务,聚焦金额是刻意行为
            autoFocus
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
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
                onClick={() => chooseParent(item.id)}
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
                onClick={() => setChildChoice(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>日期</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>

        <label className="field">
          <span>经手人</span>
          <select
            value={member?.id ?? ''}
            onChange={(event) => setMemberChoice(event.target.value)}
          >
            {members.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
                {item.id === state.member?.id ? '(我)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>备注(可选)</span>
          <input
            type="text"
            placeholder="如 楼下超市"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <label className="field">
          <span>标签(可选,逗号分隔)</span>
          <input
            type="text"
            placeholder="如 微信, 日用"
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
          />
        </label>

        {feedback ? (
          <p className={feedback.kind === 'ok' ? 'form-success' : 'form-error'}>{feedback.text}</p>
        ) : null}

        <button type="submit" className="primary-button" disabled={!canSubmit}>
          {submitting ? '保存中…' : '记下这笔'}
        </button>
      </form>

      <section className="card">
        <h2 className="card-title">最近 5 笔</h2>
        {recent.length === 0 ? (
          <p className="member-meta">还没有支出,记下第一笔吧。</p>
        ) : (
          <ul className="recent-list">
            {recent.map((expense) => (
              <li key={expense.id} className="recent-item">
                <div className="recent-main">
                  <span className="recent-category">
                    {resolveCategoryName(ledger, expense.categoryId)}
                  </span>
                  <span className="recent-meta">
                    {expense.date}
                    {expense.note ? ` · ${expense.note}` : ''}
                  </span>
                </div>
                <strong className="recent-amount">{formatCents(expense.amountCents)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
