import { useState } from 'react'
import {
  ExpenseForm,
  type ExpenseFormFeedback,
  type ExpenseFormValues,
} from '../components/ExpenseForm'
import { DEFAULT_CATEGORIES, DomainError } from '../domain'
import {
  type EntryForm,
  formatCents,
  monthSummary,
  recentExpenses,
  resolveCategoryName,
  todayKey,
} from '../features/entry'
import type { AppController, AppState } from '../state/app-controller'

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
  // 经手人只列启用成员(停用成员不能记账;登录者本人始终在列)
  const members = (
    state.members.length > 0 ? state.members : state.member ? [state.member] : []
  ).filter((m) => !m.disabled)

  const [values, setValues] = useState<ExpenseFormValues>({
    amountText: '',
    parentId: '',
    categoryId: '',
    date: today,
    note: '',
    tagsText: '',
    memberId: state.member?.id ?? '',
  })
  const [feedback, setFeedback] = useState<ExpenseFormFeedback | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = (resolved: { categoryId: string; memberId: string }): void => {
    setSubmitting(true)
    setFeedback(null)
    const form: EntryForm = {
      amountText: values.amountText,
      parentId: values.parentId,
      categoryId: resolved.categoryId,
      date: values.date,
      note: values.note,
      tagsText: values.tagsText,
      memberId: resolved.memberId,
    }
    void controller
      .recordExpense(form)
      .then(() => {
        setValues((current) => ({ ...current, amountText: '', note: '', tagsText: '' }))
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

      <ExpenseForm
        categories={categories}
        members={members}
        currentMemberId={state.member?.id}
        values={values}
        onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
        onSubmit={onSubmit}
        submitLabel="记下这笔"
        submitting={submitting}
        feedback={feedback}
        autoFocusAmount
      />

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
