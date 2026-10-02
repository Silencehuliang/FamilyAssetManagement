import type { ReactNode } from 'react'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/**
 * 装饰性图标:所在的按钮/文字已承载可访问名称,图形本身对读屏器隐藏。
 */
export function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      {children}
    </svg>
  )
}
