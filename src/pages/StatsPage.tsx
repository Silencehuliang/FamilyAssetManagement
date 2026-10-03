import type { EChartsCoreOption } from 'echarts/core'
import { useCallback, useMemo, useState } from 'react'
import { Chart } from '../components/chart/Chart'
import { categoryColor } from '../features/categories'
import type { EntryFilters } from '../features/entries'
import { formatCents, todayKey } from '../features/entry'
import {
  type CategoryLevel,
  categoryChildrenShare,
  categoryShare,
  MERGED_CATEGORY_ID,
  memberShare,
  monthsInRange,
  monthTrend,
  RANGE_LABELS,
  type RangePreset,
  type TagSlice,
  tagDetailGroups,
  tagGroupSlices,
  tagSlices,
  trendTotalCents,
  UNTAGGED_SLICE_ID,
} from '../features/stats'
import type { AppState } from '../state/app-controller'

const RANGE_ORDER: RangePreset[] = ['thisMonth', 'last3Months', 'last12Months']

type Dimension = 'category' | 'tagGroup'

type Drill =
  | { dimension: 'category'; id: string; name: string }
  | { dimension: 'tagGroup'; id: string; name: string }

/** 环形图通用分片(分类与标签组两个维度统一给 Chart 供数) */
interface DonutSlice {
  id: string
  name: string
  totalCents: number
  count: number
  percent: number
  color: string
}

const MERGED_COLOR = 'var(--tag-gray)'

function monthLabel(month: string, total: number): string {
  const number = Number(month.slice(5))
  if (number === 1 && total > 3) return `${month.slice(2, 4)}年`
  return `${number}月`
}

function expenseLineStyle(): Record<string, unknown> {
  return {
    color: 'var(--expense)',
  }
}

/**
 * 统计页(V9,ECharts):范围预设(本月/近三月/近一年)驱动趋势/占比/成员/标签明细;
 * 占比支持 分类(父/子)↔ 标签组 维度切换与扇区下钻;标签组维度附标签明细表,
 * 行点击跳转明细页并预置标签筛选。
 */
export function StatsPage({
  state,
  onOpenEntries,
}: {
  state: AppState
  onOpenEntries?: (filters: Partial<EntryFilters>) => void
}) {
  const ledger = state.ledger
  const [preset, setPreset] = useState<RangePreset>('thisMonth')
  const [dimension, setDimension] = useState<Dimension>('category')
  const [level, setLevel] = useState<CategoryLevel>('parent')
  const [drill, setDrill] = useState<Drill | null>(null)
  const anchor = todayKey().slice(0, 7)
  const months = useMemo(() => monthsInRange(anchor, preset), [anchor, preset])
  const points = useMemo(() => monthTrend(ledger, months), [ledger, months])
  const totalCents = trendTotalCents(points)
  const members = useMemo(() => memberShare(ledger, months), [ledger, months])

  const categorySlices = useMemo<DonutSlice[]>(() => {
    const slices =
      drill?.dimension === 'category'
        ? categoryChildrenShare(ledger, months, drill.id)
        : categoryShare(ledger, months, level)
    return slices.map((slice) => ({
      id: slice.id,
      name: slice.name,
      totalCents: slice.totalCents,
      count: 0,
      percent: slice.percent,
      color: slice.id === MERGED_CATEGORY_ID ? MERGED_COLOR : categoryColor(ledger, slice.id),
    }))
  }, [ledger, months, level, drill])

  const tagViewSlices = useMemo<TagSlice[]>(
    () =>
      drill?.dimension === 'tagGroup'
        ? tagSlices(ledger, months, drill.id)
        : tagGroupSlices(ledger, months),
    [ledger, months, drill],
  )

  const donutSlices = useMemo<DonutSlice[]>(
    () =>
      dimension === 'tagGroup'
        ? tagViewSlices.map((slice) => ({
            ...slice,
            color: slice.id === MERGED_CATEGORY_ID ? MERGED_COLOR : slice.color,
          }))
        : categorySlices,
    [dimension, tagViewSlices, categorySlices],
  )

  const detailGroups = useMemo(
    () => (dimension === 'tagGroup' ? tagDetailGroups(ledger, months) : []),
    [ledger, months, dimension],
  )

  const changePreset = (next: RangePreset): void => {
    setPreset(next)
    setDrill(null)
  }

  const changeDimension = (next: Dimension): void => {
    setDimension(next)
    setDrill(null)
  }

  const changeLevel = (next: CategoryLevel): void => {
    setLevel(next)
    setDrill(null)
  }

  const onDonutClick = useCallback(
    (params: unknown) => {
      if (drill) return
      const data = (params as { data?: { sliceId?: string; sliceName?: string } }).data
      const id = data?.sliceId
      const name = data?.sliceName
      if (!id || !name || id === MERGED_CATEGORY_ID || id === UNTAGGED_SLICE_ID) return
      if (dimension === 'category') {
        if (level !== 'parent') return
        setDrill({ dimension: 'category', id, name })
      } else {
        setDrill({ dimension: 'tagGroup', id, name })
      }
    },
    [dimension, drill, level],
  )

  const trendOption = useMemo<EChartsCoreOption>(() => {
    const maxCount = points.length
    return {
      grid: { left: 4, right: 12, top: 26, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: number) => formatCents(Math.round(value * 100)),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((point) => monthLabel(point.month, maxCount)),
        axisLine: { lineStyle: { color: 'var(--border)' } },
        axisTick: { show: false },
        axisLabel: { color: 'var(--muted-foreground)', fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: 'var(--border)' } },
        axisLabel: {
          color: 'var(--muted-foreground)',
          fontSize: 11,
          formatter: (value: number) => `¥${value}`,
        },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: points.map((point) => point.totalCents / 100),
          lineStyle: { width: 2, ...expenseLineStyle() },
          itemStyle: expenseLineStyle(),
          areaStyle: { color: 'var(--expense)', opacity: 0.1 },
        },
      ],
    }
  }, [points])

  const donutOption = useMemo<EChartsCoreOption>(() => {
    const legendText = new Map(
      donutSlices.map((slice) => [
        slice.name,
        `${slice.name}  ${formatCents(slice.totalCents)} · ${slice.percent}%`,
      ]),
    )
    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const data = (
            params as { name?: string; data?: { totalCents?: number; percent?: number } }
          ).data
          const name = (params as { name?: string }).name ?? ''
          const amount = formatCents(data?.totalCents ?? 0)
          return `${name}<br/>${amount} · ${data?.percent ?? 0}%`
        },
      },
      legend: {
        bottom: 0,
        type: 'scroll',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: 'var(--muted-foreground)', fontSize: 11 },
        formatter: (name: string) => legendText.get(name) ?? name,
      },
      series: [
        {
          type: 'pie',
          radius: ['35%', '55%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: 'var(--card)', borderWidth: 2 },
          label: { show: false },
          emphasis: {
            label: {
              show: true,
              formatter: '{b}',
              color: 'var(--foreground)',
              fontSize: 12,
              fontWeight: 600,
            },
          },
          data: donutSlices.map((slice) => ({
            name: slice.name,
            value: slice.totalCents,
            sliceId: slice.id,
            sliceName: slice.name,
            totalCents: slice.totalCents,
            percent: slice.percent,
            itemStyle: { color: slice.color },
          })),
        },
      ],
    }
  }, [donutSlices])

  const donutEvents = useMemo(() => ({ click: onDonutClick }), [onDonutClick])

  const memberOption = useMemo<EChartsCoreOption>(() => {
    return {
      grid: { left: 4, right: 12, top: 8, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: number) => formatCents(Math.round(value * 100)),
      },
      xAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: 'var(--border)' } },
        axisLabel: {
          color: 'var(--muted-foreground)',
          fontSize: 11,
          formatter: (value: number) => `¥${value}`,
        },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: members.map((member) => member.name),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: 'var(--muted-foreground)', fontSize: 12 },
      },
      series: [
        {
          type: 'bar',
          barWidth: 14,
          itemStyle: { color: 'var(--chart-1)', borderRadius: [0, 7, 7, 0] },
          data: members.map((member) => ({
            value: member.totalCents / 100,
            label: {
              show: true,
              position: 'right',
              color: 'var(--muted-foreground)',
              fontSize: 11,
              formatter: `${formatCents(member.totalCents)} · ${member.percent}%`,
            },
          })),
        },
      ],
    }
  }, [members])

  const donutTitle =
    dimension === 'category'
      ? drill?.dimension === 'category'
        ? `${drill.name} · 子分类占比`
        : level === 'parent'
          ? '分类占比 · 父级'
          : '分类占比 · 子级'
      : drill?.dimension === 'tagGroup'
        ? `${drill.name} · 标签占比`
        : '标签组占比'

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
              onClick={() => changePreset(item)}
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
            <Chart option={trendOption} height={190} ariaLabel="支出趋势平滑折线图" />
          </section>

          <section className="card">
            <div className="stats-head">
              <h2 className="card-title">{donutTitle}</h2>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip ${dimension === 'category' ? 'chip-active' : ''}`}
                  aria-pressed={dimension === 'category'}
                  onClick={() => changeDimension('category')}
                >
                  分类
                </button>
                <button
                  type="button"
                  className={`chip ${dimension === 'tagGroup' ? 'chip-active' : ''}`}
                  aria-pressed={dimension === 'tagGroup'}
                  onClick={() => changeDimension('tagGroup')}
                >
                  标签组
                </button>
              </div>
            </div>

            {drill ? (
              <div className="stats-drill-bar">
                <button type="button" className="text-button" onClick={() => setDrill(null)}>
                  ← 返回{drill.dimension === 'category' ? '分类' : '标签组'}
                </button>
                <span className="text-muted-foreground">
                  {drill.dimension === 'category' ? '分类' : '标签组'} / {drill.name}
                </span>
              </div>
            ) : dimension === 'category' ? (
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip ${level === 'parent' ? 'chip-active' : ''}`}
                  aria-pressed={level === 'parent'}
                  onClick={() => changeLevel('parent')}
                >
                  父级
                </button>
                <button
                  type="button"
                  className={`chip ${level === 'child' ? 'chip-active' : ''}`}
                  aria-pressed={level === 'child'}
                  onClick={() => changeLevel('child')}
                >
                  子级
                </button>
              </div>
            ) : null}

            {donutSlices.length === 0 ? (
              <p className="member-meta">
                {dimension === 'tagGroup'
                  ? '这段时间还没有带标签的支出,记一笔并打上标签后这里会出现占比。'
                  : '这段时间还没有分类支出。'}
              </p>
            ) : (
              <>
                <Chart
                  option={donutOption}
                  height={280}
                  ariaLabel="占比环形图,点击扇区可下钻"
                  onEvents={donutEvents}
                />
                {!drill && (dimension === 'tagGroup' || level === 'parent') ? (
                  <p className="member-meta">
                    点击扇区下钻{dimension === 'tagGroup' ? '' : '到子分类'}。
                  </p>
                ) : null}
              </>
            )}
          </section>

          {dimension === 'tagGroup' && !drill ? (
            <section className="card">
              <h2 className="card-title">标签明细</h2>
              {detailGroups.length === 0 ? (
                <p className="member-meta">这段时间还没有带标签的支出。</p>
              ) : (
                <div className="tag-detail-list">
                  {detailGroups.map((group) => (
                    <div key={group.id} className="tag-detail-group">
                      <div className="tag-detail-group-head">
                        <span
                          className="legend-dot"
                          style={{ background: group.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                        <span className="tabular-nums">{formatCents(group.totalCents)}</span>
                        <span className="text-muted-foreground tabular-nums">{group.count} 笔</span>
                      </div>
                      <ul>
                        {group.rows.map((row) => (
                          <li key={row.tagId}>
                            <button
                              type="button"
                              className="tag-detail-row"
                              onClick={() => onOpenEntries?.({ tagIds: [row.tagId] })}
                              disabled={!onOpenEntries}
                            >
                              <span className="min-w-0 flex-1 truncate">#{row.name}</span>
                              <span className="tabular-nums">{formatCents(row.totalCents)}</span>
                              <span className="text-muted-foreground tabular-nums">
                                {row.count} 笔 · {row.percent}%
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <section className="card">
            <h2 className="card-title">成员对比</h2>
            {members.length === 0 ? (
              <p className="member-meta">这段时间还没有成员支出记录。</p>
            ) : (
              <Chart
                option={memberOption}
                height={Math.max(120, members.length * 44 + 40)}
                ariaLabel="成员支出横向条形图"
              />
            )}
          </section>
        </>
      )}
    </div>
  )
}
