import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import type { EChartsCoreOption } from 'echarts/core'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef, useState } from 'react'

echarts.use([
  LineChart,
  PieChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
])

/**
 * ECharts 封装(V9):树摇注册折线/环形/条形 + 网格/提示/图例 + Canvas 渲染器。
 * - option 中的 CSS 令牌(如 `var(--chart-1)`)在 setOption 前经 getComputedStyle
 *   解析为具体色值(Canvas 不认 CSS 变量),因此深浅色令牌自动生效;
 * - 监听 <html> 的 class 变化(主题切换)重新解析并重设 option;
 * - ResizeObserver 跟随容器尺寸变化 resize,卸载时 dispose。
 */
export function Chart({
  option,
  height = 220,
  ariaLabel,
  onEvents,
}: {
  option: EChartsCoreOption
  height?: number
  ariaLabel?: string
  onEvents?: Record<string, (params: unknown) => void>
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const themeVersion = useThemeVersion()

  // 初始化/销毁(仅一次)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const chart = echarts.init(container)
    chartRef.current = chart

    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => chart.resize())
      observer.observe(container)
    }
    const onWindowResize = (): void => chart.resize()
    window.addEventListener('resize', onWindowResize)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onWindowResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // 数据或主题变化:重设 option(notMerge 防切换维度时残留旧系列)
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const style = getComputedStyle(document.documentElement)
    chart.setOption(resolveTokens(option, style), { notMerge: true })
    void themeVersion
  }, [option, themeVersion])

  // 事件绑定(点击下钻等)
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onEvents) return
    const entries = Object.entries(onEvents)
    for (const [type, handler] of entries) chart.on(type, handler)
    return () => {
      for (const [type] of entries) chart.off(type)
    }
  }, [onEvents])

  return (
    <div
      ref={containerRef}
      className="chart-canvas"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  )
}

const CSS_VAR_RE = /^var\((--[\w-]+)\)$/

/**
 * 递归解析 option 中的 CSS 变量引用;函数(格式化器等)原样保留,
 * 未知变量回退原字符串(echarts 会忽略不合法颜色但不至于抛错)。
 */
function resolveTokens<T>(value: T, style: CSSStyleDeclaration): T {
  if (typeof value === 'string') {
    const match = CSS_VAR_RE.exec(value)
    if (!match) return value
    const name = match[1]
    if (!name) return value
    const resolved = style.getPropertyValue(name).trim()
    return (resolved === '' ? value : resolved) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTokens(item, style)) as T
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveTokens(item, style)
    }
    return out as T
  }
  return value
}

/** <html> 的 class 变化计数(dark 切换时触发重新解析主题色) */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setVersion((current) => current + 1))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return version
}
