import { useEffect, useRef, useState } from 'react'

export interface SpringState {
  value: number
  velocity: number
}

/** 轻欠阻尼弹簧:阻尼取临界阻尼(2√170≈26.1)的约 0.8 倍,保留轻微过冲的 Cent 手感 */
export const SPRING_STIFFNESS = 170
export const SPRING_DAMPING = 21

/** 单步积分(半隐式欧拉),dt 以秒计;纯函数,便于测试 */
export function springStep(
  state: SpringState,
  target: number,
  dtSeconds: number,
  stiffness = SPRING_STIFFNESS,
  damping = SPRING_DAMPING,
): SpringState {
  const dt = Math.min(Math.max(dtSeconds, 0), 1 / 30)
  const acceleration = -stiffness * (state.value - target) - damping * state.velocity
  const velocity = state.velocity + acceleration * dt
  const value = state.value + velocity * dt
  return { value, velocity }
}

/**
 * 手写 rAF 弹簧数字(不引入 motion 依赖):目标变化时从当前值弹向目标,
 * 收敛后停在目标整数上;首次挂载从 0 弹入。
 * prefers-reduced-motion: reduce 或文档处于隐藏状态(后台标签页 rAF 被节流)时
 * 直接跳到目标值,避免数值长期停在起始值。
 */
export function useSpringNumber(target: number): number {
  const [display, setDisplay] = useState(0)
  const springRef = useRef<SpringState>({ value: 0, velocity: 0 })

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion || (typeof document !== 'undefined' && document.hidden)) {
      springRef.current = { value: target, velocity: 0 }
      setDisplay(Math.round(target))
      return
    }

    let frame: number | null = null
    let last = performance.now()
    let frameSeen = false

    // 兜底:某些渲染环境(后台标签页/被遮挡的 embed)IAB 会饿死 rAF 但 visibilityState 仍为 visible,
    // 首帧迟迟不来会让数值停在起始值;500ms 内没有任何帧就直接贴到目标。
    const fallback = window.setTimeout(() => {
      if (frameSeen) return
      springRef.current = { value: target, velocity: 0 }
      setDisplay(Math.round(target))
      if (frame !== null) window.cancelAnimationFrame(frame)
    }, 500)

    const tick = (now: number): void => {
      frameSeen = true
      const dt = (now - last) / 1000
      last = now
      const next = springStep(springRef.current, target, dt)
      springRef.current = next
      if (Math.abs(next.value - target) < 0.5 && Math.abs(next.velocity) < 0.5) {
        springRef.current = { value: target, velocity: 0 }
        setDisplay(Math.round(target))
        return
      }
      setDisplay(Math.round(next.value))
      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => {
      window.clearTimeout(fallback)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [target])

  return display
}
