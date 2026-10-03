import { useState } from 'react'
import MdiChevronLeft from '~icons/mdi/chevron-left'
import MdiChevronRight from '~icons/mdi/chevron-right'
import { useDialog } from '../components/dialog'
import { EditExpenseDialog } from '../components/EditExpenseDialog'
import type { Expense } from '../domain'
import { categoryColor } from '../features/categories'
import {
  canEditEntry,
  EMPTY_FILTERS,
  type EntryFilters,
  filterExpenses,
  formatDayLabel,
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

/**
 * 明细页(T7):按月浏览,按日倒序分组展示日小计与月合计;
 * 分类/成员/标签/关键词四种筛选可组合、一键清空;
 * 仅对自己有编辑权的记录提供编辑/删除入口(管理员可改任何记录)。
 */
export function EntriesPage({
  controller,
  state,
  preset,
}: {
  controller: AppController
  state: AppState
  /** 统计页跳转预置的筛选(仅初始值,V9) */
  preset?: Partial<EntryFilters>
}) {
  const ledger = state.ledger
  const actor = state.member
  const currentMonth = todayKey().slice(0, 7)
  const { showDialog } = useDialog()

  const [month, setMonth] = useState(currentMonth)
  const [filters, setFilters] = useState<EntryFilters>(() => ({ ...EMPTY_FILTERS, ...preset }))

  const monthExpenses = ledger.months[month]?.expenses ?? []
  const visible = filterExpenses(ledger, monthExpenses, filters)
  const groups = groupByDay(ledger, visible)
  const options = monthOptions(ledger, month, currentMonth)
  const tags = tagsOfMonth(ledger, month)
  const { parents, childrenByParent } = groupCategories(ledger.meta.categories)
  const children = filters.parentId ? (childrenByParent[filters.parentId] ?? []) : []
  const filtering = hasActiveFilters(filters)
  const activeMembers = state.members

  const openEdit = (expense: Expense): void => {
    if (!actor || !canEditEntry(actor, expense)) return
    void showDialog<void>(
      ({ close }) => (
        <EditExpenseDialog
          controller={controller}
          state={state}
          expense={expense}
          onClose={() => close(undefined)}
        />
      ),
      { label: '编辑支出' },
    )
  }

  /** 切月:标签选项按月生成,切月时清掉已选标签避免悬空 */
  const changeMonth = (next: string): void => {
    setMonth(next)
    setFilters((current) => (current.tag === '' ? current : { ...current, tag: '' }))
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
            <MdiChevronLeft className="size-5" />
          </button>
          <div className="chip-row month-row scrollbar-hidden">
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
            <MdiChevronRight className="size-5" />
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

      {groups.length === 0 ? (
        <section className="placeholder-card">
          <p className="placeholder-title">本月还没有支出</p>
          <p className="placeholder-note">
            {filtering ? '试试换个筛选条件,或清空筛选。' : '去首页的「记一笔」记下第一笔吧。'}
          </p>
        </section>
      ) : (
        groups.map((group) => (
          <section className="card" key={group.date}>
            <div className="day-header">
              <span>{formatDayLabel(group.date)}</span>
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
                      <span className="entry-category inline-flex items-center gap-1.5">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: categoryColor(ledger, expense.categoryId) }}
                          aria-hidden="true"
                        />
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
    </div>
  )
}
