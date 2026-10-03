import { useState } from 'react'
import MdiChevronLeft from '~icons/mdi/chevron-left'
import MdiChevronRight from '~icons/mdi/chevron-right'
import { useBillEditor } from '../components/editor'
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
  type TagFilterGroup,
  tagFilterGroups,
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
  const openBillEditor = useBillEditor(controller)

  const [month, setMonth] = useState(currentMonth)
  const [filters, setFilters] = useState<EntryFilters>(() => ({ ...EMPTY_FILTERS, ...preset }))

  const monthExpenses = ledger.months[month]?.expenses ?? []
  const visible = filterExpenses(ledger, monthExpenses, filters)
  const groups = groupByDay(ledger, visible)
  const options = monthOptions(ledger, month, currentMonth)
  const filterTagGroups = tagFilterGroups(ledger, month, preset?.tagIds ?? [])
  const { parents, childrenByParent } = groupCategories(ledger.meta.categories)
  const children = filters.parentId ? (childrenByParent[filters.parentId] ?? []) : []
  const filtering = hasActiveFilters(filters)
  const activeMembers = state.members

  const openEdit = (expense: Expense): void => {
    if (!actor || !canEditEntry(actor, expense)) return
    // #29:编辑已有支出复用全屏编辑器(与首页/FAB 同一入口)
    void openBillEditor({ expense })
  }

  /** 切月:标签选项按月生成,切月时清掉已选标签避免悬空 */
  const changeMonth = (next: string): void => {
    setMonth(next)
    setFilters((current) => (current.tagIds.length === 0 ? current : { ...current, tagIds: [] }))
  }

  const toggleTag = (id: string): void => {
    setFilters((current) => ({
      ...current,
      tagIds: current.tagIds.includes(id)
        ? current.tagIds.filter((tagId) => tagId !== id)
        : [...current.tagIds, id],
    }))
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

        {filterTagGroups.length > 0 ? (
          <div className="tag-filter">
            <div className="tag-filter-head">
              <span className="text-[13px] text-muted-foreground">标签</span>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip ${filters.tagMode === 'include' ? 'chip-active' : ''}`}
                  aria-pressed={filters.tagMode === 'include'}
                  onClick={() => setFilters((f) => ({ ...f, tagMode: 'include' }))}
                >
                  包含
                </button>
                <button
                  type="button"
                  className={`chip ${filters.tagMode === 'exclude' ? 'chip-active' : ''}`}
                  aria-pressed={filters.tagMode === 'exclude'}
                  onClick={() => setFilters((f) => ({ ...f, tagMode: 'exclude' }))}
                >
                  排除
                </button>
              </div>
            </div>
            {filterTagGroups.map((group) => (
              <TagGroupFilter
                key={group.id}
                group={group}
                selectedIds={filters.tagIds}
                onToggle={toggleTag}
              />
            ))}
            {filters.tagIds.length > 0 ? (
              <p className="member-meta">
                已选 {filters.tagIds.length} 个标签 ·{' '}
                {filters.tagMode === 'include' ? '含任一选中标签' : '剔除带任一选中标签的支出'}
              </p>
            ) : null}
          </div>
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
                      {expense.tagChips.length > 0 ? (
                        <span className="entry-tags">
                          {expense.tagChips.map((chip) => (
                            <span
                              key={chip.id}
                              className={`entry-tag ${chip.color ? `entry-tag-${chip.color}` : ''}`}
                            >
                              #{chip.name}
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

/** 按标签组折叠展示的筛选 chips(V10):组色圆点 + 组内多选,默认展开 */
function TagGroupFilter({
  group,
  selectedIds,
  onToggle,
}: {
  group: TagFilterGroup
  selectedIds: string[]
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  const selected = group.tags.filter((tag) => selectedIds.includes(tag.id)).length

  return (
    <details
      className="tag-filter-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {group.color ? (
          <span
            className="legend-dot"
            style={{ background: `var(--tag-${group.color})` }}
            aria-hidden="true"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
        {selected > 0 ? <span className="text-muted-foreground">已选 {selected}</span> : null}
      </summary>
      <div className="chip-row">
        {group.tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className={`chip ${selectedIds.includes(tag.id) ? 'chip-active' : ''}`}
            aria-pressed={selectedIds.includes(tag.id)}
            onClick={() => onToggle(tag.id)}
          >
            #{tag.name}
          </button>
        ))}
      </div>
    </details>
  )
}
