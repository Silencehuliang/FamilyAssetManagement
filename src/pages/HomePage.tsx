import { formatCents, monthSummary, recentExpenses, todayKey } from '../features/entry'
import type { AppController, AppState } from '../state/app-controller'

/**
 * 首页(V3 骨架):今日/本月汇总 + 快速入口。
 * 三层结构(今日大字卡 / 小组件横滑 / 吸顶账单流)由 V4(#26)完成。
 */
export function HomePage({
  state,
  onOpenAdd,
  onOpenStats,
}: {
  controller: AppController
  state: AppState
  onOpenAdd: () => void
  onOpenStats: () => void
}) {
  const ledger = state.ledger
  const today = todayKey()
  const summary = monthSummary(ledger, today.slice(0, 7), today)
  const recent = recentExpenses(ledger, 3)

  return (
    <div className="page">
      <section className="summary-card">
        <div className="summary-item">
          <span className="summary-label">今日支出</span>
          <strong className="summary-value">{formatCents(summary.todayTotalCents)}</strong>
        </div>
        <div className="summary-item">
          <span className="summary-label">本月支出</span>
          <strong className="summary-value">{formatCents(summary.monthTotalCents)}</strong>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">首页</h2>
        <p className="member-meta">
          今日大字卡、小组件轮播与账单流将在 V4(工单 #26)接入;当前为可用的汇总骨架。
        </p>
        {recent.length > 0 ? (
          <p className="member-meta">
            最近一笔:
            {recent[0] ? `${recent[0].date} · ${formatCents(recent[0].amountCents)}` : ''}
          </p>
        ) : null}
        <button type="button" className="primary-button" onClick={onOpenAdd}>
          记一笔
        </button>
        <button type="button" className="link-button" onClick={onOpenStats}>
          查看统计
        </button>
      </section>
    </div>
  )
}
