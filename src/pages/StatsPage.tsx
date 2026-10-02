import { useState } from 'react'
import { formatCents, todayKey } from '../features/entry'
import {
  type CategoryLevel,
  type CategorySlice,
  categoryShare,
  type MemberSlice,
  type MonthPoint,
  memberShare,
  monthsInRange,
  monthTrend,
  RANGE_LABELS,
  type RangePreset,
  trendTotalCents,
} from '../features/stats'
import type { AppState } from '../state/app-controller'

const RANGE_ORDER: RangePreset[] = ['thisMonth', 'last3Months', 'last12Months']

/** 图表色板走 CSS 变量,深浅色模式各自适配 */
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
]

function sliceColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--text-dim)'
}

/**
 * 月趋势柱状图(T10,手写 SVG,无图表库)。柱高按范围内最大值归一;
 * 月份 ≤3 时柱顶标注金额,12 个月时只保留月份标签。
 */
function TrendChart({ points }: { points: MonthPoint[] }) {
  const width = 320
  const height = 132
  const labelZone = 20
  const maxCents = Math.max(...points.map((point) => point.totalCents), 1)
  const gap = points.length > 6 ? 4 : 10
  const slot = width / points.length
  const barWidth = Math.min(slot - gap, 72)
  const plotHeight = height - labelZone - 14

  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="支出趋势柱状图"
    >
      {points.map((point, index) => {
        const barHeight =
          point.totalCents === 0 ? 0 : Math.max(2, (point.totalCents / maxCents) * plotHeight)
        const x = index * slot + (slot - barWidth) / 2
        const y = labelZone + (plotHeight - barHeight)
        const monthNumber = Number(point.month.slice(5))
        return (
          <g key={point.month}>
            <rect
              className={point.totalCents > 0 ? 'chart-bar' : 'chart-bar chart-bar-empty'}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={3}
            />
            {points.length <= 3 && point.totalCents > 0 ? (
              <text className="chart-value" x={x + barWidth / 2} y={y - 4} textAnchor="middle">
                {formatCents(point.totalCents)}
              </text>
            ) : null}
            <text className="chart-label" x={x + barWidth / 2} y={height - 4} textAnchor="middle">
              {monthNumber === 1 && points.length > 3
                ? `${point.month.slice(2, 4)}年`
                : `${monthNumber}月`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 分类占比环形图:stroke-dasharray 分段拼接,中心显示总额 */
function DonutChart({ slices, totalCents }: { slices: CategorySlice[]; totalCents: number }) {
  const size = 168
  const center = size / 2
  const radius = 58
  const strokeWidth = 26
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <svg
      className="chart-svg donut"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="分类占比环形图"
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
            stroke={sliceColor(index)}
            strokeWidth={strokeWidth}
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )
      })}
      <text className="donut-total" x={center} y={center - 2} textAnchor="middle">
        {formatCents(totalCents)}
      </text>
      <text className="donut-caption" x={center} y={center + 16} textAnchor="middle">
        总支出
      </text>
    </svg>
  )
}

function MemberBars({ members }: { members: MemberSlice[] }) {
  return (
    <ul className="bar-list">
      {members.map((member) => (
        <li key={member.id} className="bar-item">
          <div className="bar-head">
            <span>{member.name}</span>
            <span className="bar-amount">
              {formatCents(member.totalCents)} · {member.percent}%
            </span>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${Math.max(member.percent, 2)}%` }}
              aria-hidden="true"
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * 统计页(T10):范围切换(本月/近三月/近一年)作用于全部视图;
 * 趋势柱状图、分类占比(父/子级切换、长尾归并「其他」)与成员对比均手写 SVG/CSS,
 * 不引入图表库;范围内无数据时显示空状态。
 */
export function StatsPage({ state }: { state: AppState }) {
  const ledger = state.ledger
  const [preset, setPreset] = useState<RangePreset>('thisMonth')
  const [level, setLevel] = useState<CategoryLevel>('parent')
  const anchor = todayKey().slice(0, 7)
  const months = monthsInRange(anchor, preset)
  const points = monthTrend(ledger, months)
  const totalCents = trendTotalCents(points)
  const slices = categoryShare(ledger, months, level)
  const members = memberShare(ledger, months)

  return (
    <div className="page">
      <section className="card">
        <div className="chip-row">
          {RANGE_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              className={`chip ${preset === item ? 'chip-active' : ''}`}
              aria-pressed={preset === item}
              onClick={() => setPreset(item)}
            >
              {RANGE_LABELS[item]}
            </button>
          ))}
        </div>
        <p className="member-meta stats-range-hint">
          {RANGE_LABELS[preset]} · 合计 <strong>{formatCents(totalCents)}</strong>
        </p>
      </section>

      {totalCents === 0 ? (
        <section className="placeholder-card">
          <p className="placeholder-title">这段时间还没有支出</p>
          <p className="placeholder-note">去「记一笔」记下开销,趋势和占比会出现在这里。</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2 className="card-title">支出趋势({points.length} 个月)</h2>
            <TrendChart points={points} />
          </section>

          <section className="card">
            <div className="stats-head">
              <h2 className="card-title">分类占比</h2>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip ${level === 'parent' ? 'chip-active' : ''}`}
                  aria-pressed={level === 'parent'}
                  onClick={() => setLevel('parent')}
                >
                  父级
                </button>
                <button
                  type="button"
                  className={`chip ${level === 'child' ? 'chip-active' : ''}`}
                  aria-pressed={level === 'child'}
                  onClick={() => setLevel('child')}
                >
                  子级
                </button>
              </div>
            </div>
            <DonutChart slices={slices} totalCents={totalCents} />
            <ul className="legend-list">
              {slices.map((slice, index) => (
                <li key={slice.id} className="legend-item">
                  <span
                    className="legend-dot"
                    style={{ background: sliceColor(index) }}
                    aria-hidden="true"
                  />
                  <span className="legend-name">{slice.name}</span>
                  <span className="legend-amount">{formatCents(slice.totalCents)}</span>
                  <span className="legend-percent">{slice.percent}%</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2 className="card-title">成员对比</h2>
            {members.length === 0 ? (
              <p className="member-meta">这段时间还没有成员支出记录。</p>
            ) : (
              <MemberBars members={members} />
            )}
          </section>
        </>
      )}
    </div>
  )
}
