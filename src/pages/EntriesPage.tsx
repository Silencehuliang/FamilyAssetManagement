import { useState } from 'react'
import {
  ExpenseForm,
  type ExpenseFormFeedback,
  type ExpenseFormValues,
} from '../components/ExpenseForm'
import type { Expense } from '../domain'
import { DomainError } from '../domain/types'
import {
  canEditEntry,
  EMPTY_FILTERS,
  type EntryFilters,
  expenseToForm,
  filterExpenses,
  groupByDay,
  hasActiveFilters,
  memberNameOf,
  monthOptions,
  shiftMonth,
  sumCents,
  tagsOfMonth,
} from '../features/entries'
import { formatCents, groupCategories, resolveCategoryPath, todayKey } from '../features/entry'
import type { AppController, AppState } from '../state/app-controller'

const WEEKDAYS = '日一二三四五六'

function dayLabel(date: string): string {
  const [, month = '', day = ''] = date.split('-')
  const weekday = new Date(`${date}T00:00:00`).getDay()
  return `${Number(month)}月${Number(day)}日 周${WEEKDAYS[weekday] ?? ''}`
}

function errorText(err: unknown): string {
  if (err instanceof DomainError || err instanceof Error) return err.message
  return '操作失败,请重试'
}

/**
 * 明细页(T7):按月浏览,按日倒序分组展示日小计与月合计;
 * 分类/成员/标签/关键词四种筛选可组合、一键清空;
 * 仅对自己有编辑权的记录提供编辑/删除入口(管理员可改任何记录)。
 */
export function EntriesPage({ controller, state }: { controller: AppController; state: AppState }) {
  const ledger = state.ledger
  const actor = state.member
  const currentMonth = todayKey().slice(0, 7)

  const [month, setMonth] = useState(currentMonth)
  const [filters, setFilters] = useState<EntryFilters>(EMPTY_FILTERS)
  const [editing, setEditing] = useState<{ id: string; values: ExpenseFormValues } | null>(null)
  const [feedback, setFeedback] = useState<ExpenseFormFeedback | null>(null)
  const [sheetFeedback, setSheetFeedback] = useState<ExpenseFormFeedback | null>(null)
  const [busy, setBusy] = useState(false)

  const monthExpenses = ledger.months[month]?.expenses ?? []
  const visible = filterExpenses(ledger, monthExpenses, filters)
  const groups = groupByDay(visible)
  const options = monthOptions(ledger, month, currentMonth)
  const tags = tagsOfMonth(ledger, month)
  const { parents, childrenByParent } = groupCategories(ledger.meta.categories)
  const children = filters.parentId ? (childrenByParent[filters.parentId] ?? []) : []
  const filtering = hasActiveFilters(filters)
  const activeMembers = state.members

  const openEdit = (expense: Expense): void => {
    if (!actor || !canEditEntry(actor, expense)) return
    setSheetFeedback(null)
    setEditing({ id: expense.id, values: expenseToForm(ledger, expense) })
  }

  /** 切月:标签选项按月生成,切月时清掉已选标签避免悬空 */
  const changeMonth = (next: string): void => {
    setMonth(next)
    setFilters((current) => (current.tag === '' ? current : { ...current, tag: '' }))
  }

  const saveEdit = (resolved: { categoryId: string; memberId: string }): void => {
    if (!editing) return
    setBusy(true)
    setSheetFeedback(null)
    void controller
      .updateExpense(editing.id, { ...editing.values, ...resolved })
      .then(() => {
        setEditing(null)
        setFeedback({ kind: 'ok', text: '已保存修改' })
      })
      .catch((err: unknown) => {
        setSheetFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const deleteEditing = (): void => {
    if (!editing) return
    if (!window.confirm('删除这笔支出?删除会同步到所有设备。')) return
    setBusy(true)
    setSheetFeedback(null)
    void controller
      .deleteExpense(editing.id)
      .then(() => {
        setEditing(null)
        setFeedback({ kind: 'ok', text: '已删除' })
      })
      .catch((err: unknown) => {
        setSheetFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div className="page">
      <section className="card">
        <div className="month-bar">
          <button
            type="button"
            className="month-arrow"
            aria-label="上一月"
            onClick={() => changeMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          <div className="chip-row month-row">
            {options.map((option) => (
              <button
                key={option.month}
                type="button"
                className={`chip ${month === option.month ? 'chip-active' : ''} ${
                  option.hasData ? 'month-has-data' : ''
                }`}
                aria-pressed={month === option.month}
                onClick={() => changeMonth(option.month)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="month-arrow"
            aria-label="下一月"
            onClick={() => changeMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
        <div className="month-total">
          <span className="member-meta">
            {filtering ? '筛选合计' : '本月合计'} · {visible.length} 笔
          </span>
          <strong className="month-total-value">{formatCents(sumCents(visible))}</strong>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">筛选</h2>
        <div className="chip-row">
          <button
            type="button"
            className={`chip ${filters.parentId === '' ? 'chip-active' : ''}`}
            onClick={() => setFilters((f) => ({ ...f, parentId: '', categoryId: '' }))}
          >
            全部分类
          </button>
          {parents.map((parent) => (
            <button
              key={parent.id}
              type="button"
              className={`chip ${filters.parentId === parent.id ? 'chip-active' : ''}`}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  parentId: f.parentId === parent.id ? '' : parent.id,
                  categoryId: '',
                }))
              }
            >
              {parent.name}
            </button>
          ))}
        </div>
        {children.length > 0 ? (
          <div className="chip-row chip-row-child">
            <button
              type="button"
              className={`chip ${filters.categoryId === '' ? 'chip-active' : ''}`}
              onClick={() => setFilters((f) => ({ ...f, categoryId: '' }))}
            >
              全部子类
            </button>
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                className={`chip ${filters.categoryId === child.id ? 'chip-active' : ''}`}
                onClick={() =>
                  setFilters((f) => ({
                    ...f,
                    categoryId: f.categoryId === child.id ? '' : child.id,
                  }))
                }
              >
                {child.name}
              </button>
            ))}
          </div>
        ) : null}

        <label className="field">
          <span>成员</span>
          <select
            value={filters.memberId}
            onChange={(event) => setFilters((f) => ({ ...f, memberId: event.target.value }))}
          >
            <option value="">全部成员</option>
            {activeMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>

        {tags.length > 0 ? (
          <label className="field">
            <span>标签</span>
            <select
              value={filters.tag}
              onChange={(event) => setFilters((f) => ({ ...f, tag: event.target.value }))}
            >
              <option value="">全部标签</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span>关键词</span>
          <input
            type="text"
            placeholder="备注 / 分类 / 标签"
            value={filters.keyword}
            onChange={(event) => setFilters((f) => ({ ...f, keyword: event.target.value }))}
          />
        </label>

        <button
          type="button"
          className="link-button"
          disabled={!filtering}
          onClick={() => setFilters(EMPTY_FILTERS)}
        >
          清空筛选
        </button>
      </section>

      {feedback ? (
        <p className={feedback.kind === 'ok' ? 'form-success' : 'form-error'}>{feedback.text}</p>
      ) : null}

      {groups.length === 0 ? (
        <section className="placeholder-card">
          <p className="placeholder-title">本月还没有支出</p>
          <p className="placeholder-note">
            {filtering ? '试试换个筛选条件,或清空筛选。' : '去「记一笔」记下第一笔吧。'}
          </p>
        </section>
      ) : (
        groups.map((group) => (
          <section className="card" key={group.date}>
            <div className="day-header">
              <span>{dayLabel(group.date)}</span>
              <span className="day-total">{formatCents(group.totalCents)}</span>
            </div>
            <ul className="entry-list">
              {group.expenses.map((expense) => {
                const editable = actor ? canEditEntry(actor, expense) : false
                return (
                  <li key={expense.id} className="entry-item">
                    <button
                      type="button"
                      className="entry-main"
                      disabled={!editable}
                      title={editable ? '点击编辑' : '只能编辑自己记录的支出'}
                      onClick={() => openEdit(expense)}
                    >
                      <span className="entry-category">
                        {resolveCategoryPath(ledger, expense.categoryId)}
                      </span>
                      <span className="entry-meta">
                        {memberNameOf(ledger, expense.memberId)}
                        {expense.note ? ` · ${expense.note}` : ''}
                      </span>
                      {expense.tagNames.length > 0 ? (
                        <span className="entry-tags">
                          {expense.tagNames.map((tag) => (
                            <span key={tag} className="entry-tag">
                              #{tag}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </button>
                    <strong className="entry-amount">{formatCents(expense.amountCents)}</strong>
                  </li>
                )
              })}
            </ul>
          </section>
        ))
      )}

      {editing ? (
        <div className="sheet-backdrop">
          <section className="sheet" aria-label="编辑支出">
            <div className="sheet-header">
              <h2 className="card-title">编辑支出</h2>
              <button
                type="button"
                className="link-button sheet-close"
                onClick={() => setEditing(null)}
              >
                关闭
              </button>
            </div>
            <ExpenseForm
              categories={ledger.meta.categories}
              members={state.members}
              currentMemberId={state.member?.id}
              values={editing.values}
              onChange={(patch) =>
                setEditing((current) =>
                  current ? { ...current, values: { ...current.values, ...patch } } : current,
                )
              }
              onSubmit={saveEdit}
              submitLabel="保存修改"
              submitting={busy}
              feedback={sheetFeedback}
              footer={
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy}
                  onClick={deleteEditing}
                >
                  删除这笔
                </button>
              }
            />
          </section>
        </div>
      ) : null}
    </div>
  )
}
