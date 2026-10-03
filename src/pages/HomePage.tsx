import { useCallback, useEffect, useRef, useState } from 'react'
import MdiChevronRight from '~icons/mdi/chevron-right'
import MdiPlus from '~icons/mdi/plus'
import { AnimatedNumber } from '../components/AnimatedNumber'
import { useDialog } from '../components/dialog'
import { EditExpenseDialog } from '../components/EditExpenseDialog'
import type { Expense } from '../domain'
import { canEditEntry, memberNameOf } from '../features/entries'
import { formatCents, resolveCategoryName, todayKey } from '../features/entry'
import {
  activeDotIndex,
  budgetWidget,
  categoryAccent,
  homeBillGroups,
  homeDayLabel,
  homeDonut,
  homeSummary,
} from '../features/home'
import { type CategorySlice, chartColor } from '../features/stats'
import type { AppController, AppState } from '../state/app-controller'

const WIDGET_CLASS =
  'flex min-h-[100px] w-full flex-shrink-0 snap-center flex-col rounded-lg border border-border bg-card p-4 text-left'

/**
 * 首页(V4,Cent 三层结构):
 * 1. 今日深色大字卡(净支出弹簧动画);
 * 2. 小组件横滑 rail(本月花销 / 预算进度 / 分类占比,分页点联动);
 * 3. 按日分组的账单流(日期吸顶、当日小计、时间线、The end)。
 */
export function HomePage({
  controller,
  state,
  onOpenAdd,
  onOpenStats,
  onOpenBudget,
}: {
  controller: AppController
  state: AppState
  onOpenAdd: () => void
  onOpenStats: () => void
  onOpenBudget: () => void
}) {
  const ledger = state.ledger
  const today = todayKey()
  const month = today.slice(0, 7)
  const summary = homeSummary(ledger, today)
  const budget = budgetWidget(ledger, month)
  const slices = homeDonut(ledger, month)
  const donutTotal = slices.reduce((total, slice) => total + slice.totalCents, 0)
  const groups = homeBillGroups(ledger)
  const { showDialog } = useDialog()

  const railRef = useRef<HTMLDivElement | null>(null)
  const [activeWidget, setActiveWidget] = useState(0)

  const syncActive = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    // 全部换到 rail 滚动坐标系:子元素中心 = rect 中心 - rail 左缘 + scrollLeft,
    // 避免 offsetLeft(document 空间)与 scrollLeft(元素空间)混用
    const railRect = rail.getBoundingClientRect()
    const centers = Array.from(rail.children).map((child) => {
      const rect = child.getBoundingClientRect()
      return rect.left + rect.width / 2 - railRect.left + rail.scrollLeft
    })
    const next = activeDotIndex(rail.scrollLeft, rail.clientWidth, centers)
    setActiveWidget((current) => (current === next ? current : next))
  }, [])

  // scrollend 事件在不支持的浏览器里静默跳过,onScroll 兜底
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    rail.addEventListener('scrollend', syncActive)
    return () => rail.removeEventListener('scrollend', syncActive)
  }, [syncActive])

  const openEdit = (expense: Expense): void => {
    if (!state.member || !canEditEntry(state.member, expense)) return
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

  return (
    <div className="page">
      {/* 1. 今日卡 */}
      <section className="min-h-20 rounded-lg bg-stone-800 p-4 text-stone-50">
        <div className="flex items-center justify-between text-xs opacity-80">
          <span>
            {homeDayLabel(today, today)} · {today.slice(5)}
          </span>
          <span>
            {state.member?.displayName ?? '家庭'} 的账本 · 今日 {summary.todayCount} 笔
          </span>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <AnimatedNumber
            value={summary.todayTotalCents}
            format={formatCents}
            className="text-4xl font-bold tabular-nums"
          />
          <span className="pb-1 text-xs opacity-70">
            本月 {formatCents(summary.monthTotalCents)}
          </span>
        </div>
      </section>

      {/* 2. 小组件 rail */}
      <section aria-label="概览小组件">
        <div
          ref={railRef}
          onScroll={syncActive}
          className="scrollbar-hidden -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
        >
          <button type="button" className={WIDGET_CLASS} onClick={onOpenStats}>
            <p className="card-title">本月花销</p>
            <AnimatedNumber
              value={summary.monthTotalCents}
              format={formatCents}
              className="text-2xl font-bold tabular-nums"
            />
            <p className="member-meta">{summary.monthCount} 笔 · 点击看统计</p>
          </button>

          <button type="button" className={WIDGET_CLASS} onClick={onOpenBudget}>
            <p className="card-title">预算进度</p>
            {budget ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-xl tabular-nums">{formatCents(budget.spentCents)}</strong>
                  <span className="text-xs text-muted-foreground">
                    / {formatCents(budget.totalCents)}
                  </span>
                </div>
                <div className="progress-track mt-2">
                  <div
                    className={`progress-fill ${budget.overspent ? 'progress-over' : ''}`}
                    style={{ width: `${budget.percent}%` }}
                  />
                </div>
                <p className={`member-meta ${budget.overspent ? 'amount-over' : ''}`}>
                  {budget.overspent
                    ? `超支 ${formatCents(-budget.remainingCents)}`
                    : `余 ${formatCents(budget.remainingCents)}`}
                </p>
              </>
            ) : (
              <p className="member-meta">本月还没有总预算,点这里去设置上限。</p>
            )}
          </button>

          <button type="button" className={WIDGET_CLASS} onClick={onOpenStats}>
            <p className="card-title">分类占比</p>
            {donutTotal > 0 ? (
              <div className="flex items-center gap-3">
                <MiniDonut slices={slices} totalCents={donutTotal} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  {slices.slice(0, 3).map((slice, index) => (
                    <span key={slice.id} className="flex items-center gap-1.5 text-xs">
                      <span
                        className="size-2 shrink-0 rounded-sm"
                        style={{ background: chartColor(index) }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{slice.name}</span>
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        {slice.percent}%
                      </span>
                    </span>
                  ))}
                </span>
              </div>
            ) : (
              <p className="member-meta">本月还没有支出,记一笔后这里会出现占比。</p>
            )}
          </button>
        </div>
        <div className="flex justify-center gap-1.5 pt-2">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={`size-1.5 rounded-full ${
                index === activeWidget ? 'bg-foreground' : 'bg-border'
              }`}
              aria-hidden="true"
            />
          ))}
        </div>
      </section>

      {/* 3. 账单流 */}
      {groups.length === 0 ? (
        <section className="placeholder-card">
          <p className="placeholder-title">还没有支出</p>
          <p className="placeholder-note">记下第一笔,今天卡与占比图就会亮起来。</p>
          <button
            type="button"
            className="primary-button mt-4 inline-flex items-center justify-center gap-1"
            onClick={onOpenAdd}
          >
            <MdiPlus className="size-4" />
            记一笔
          </button>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <section key={group.date}>
              <div className="sticky top-0 z-10 flex items-baseline justify-between border-b border-border bg-background/80 px-1 py-1.5 text-[13px] text-muted-foreground backdrop-blur-sm">
                <span>{homeDayLabel(group.date, today)}</span>
                <span className="tabular-nums">{formatCents(group.totalCents)}</span>
              </div>
              <ul className="mt-1 ml-2.5 border-l border-border">
                {group.expenses.map((expense) => {
                  const editable = state.member ? canEditEntry(state.member, expense) : false
                  return (
                    <li key={expense.id} className="relative">
                      <span
                        className="absolute top-1/2 left-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 bg-transparent py-2.5 pr-1 pl-4 text-left"
                        disabled={!editable}
                        title={editable ? '点击编辑' : '只能编辑自己记录的支出'}
                        onClick={() => openEdit(expense)}
                      >
                        <span
                          className="size-9 shrink-0 rounded-md"
                          style={{ background: categoryAccent(ledger, expense.categoryId) }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium">
                              {resolveCategoryName(ledger, expense.categoryId)}
                            </span>
                            {expense.tagNames.map((tag) => (
                              <span key={tag} className="entry-tag">
                                #{tag}
                              </span>
                            ))}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {memberNameOf(ledger, expense.memberId)}
                            {expense.note ? ` · ${expense.note}` : ''}
                          </span>
                        </span>
                        <strong className="shrink-0 text-[15px] tabular-nums">
                          {formatCents(expense.amountCents)}
                        </strong>
                        <MdiChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          <p className="py-6 text-center text-xs text-muted-foreground">The end</p>
        </div>
      )}
    </div>
  )
}

/** 迷你环形图(图表内部实现,手写 SVG;色彩走 chart 令牌) */
function MiniDonut({ slices, totalCents }: { slices: CategorySlice[]; totalCents: number }) {
  const size = 72
  const strokeWidth = 12
  const radius = (size - strokeWidth) / 2
  const center = size / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="分类占比迷你环形图"
      className="shrink-0"
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
      />
      {slices.map((slice, index) => {
        const length = totalCents > 0 ? (slice.totalCents / totalCents) * circumference : 0
        const dashOffset = -offset
        offset += length
        return (
          <circle
            key={slice.id}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={chartColor(index)}
            strokeWidth={strokeWidth}
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )
      })}
    </svg>
  )
}
