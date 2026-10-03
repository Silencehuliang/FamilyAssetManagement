import { describe, expect, it } from 'vitest'
import { SPRING_DAMPING, SPRING_STIFFNESS, type SpringState, springStep } from './use-spring-number'

describe('springStep(弹簧积分)', () => {
  it('从 0 向目标收敛且不越过目标过远', () => {
    let state: SpringState = { value: 0, velocity: 0 }
    let maxOvershoot = 0
    for (let i = 0; i < 240; i += 1) {
      state = springStep(state, 100, 1 / 60)
      maxOvershoot = Math.max(maxOvershoot, state.value - 100)
    }
    expect(Math.abs(state.value - 100)).toBeLessThan(0.01)
    expect(state.velocity).toBeLessThan(0.01)
    expect(maxOvershoot).toBeLessThan(25)
  })

  it('dt 钳制在 1/30 秒,避免后台标签页恢复时跳变', () => {
    const bigStep = springStep({ value: 0, velocity: 0 }, 100, 5)
    const clampedStep = springStep({ value: 0, velocity: 0 }, 100, 1 / 30)
    expect(bigStep).toEqual(clampedStep)
  })

  it('自定义刚度/阻尼同样收敛', () => {
    let state: SpringState = { value: 0, velocity: 0 }
    for (let i = 0; i < 600; i += 1) {
      state = springStep(state, 10, 1 / 60, SPRING_STIFFNESS / 2, SPRING_DAMPING / 2)
    }
    expect(Math.abs(state.value - 10)).toBeLessThan(0.01)
  })
})
