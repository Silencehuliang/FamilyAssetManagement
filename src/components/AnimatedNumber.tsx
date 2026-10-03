import { useSpringNumber } from './use-spring-number'

/** 弹簧动画数字:值变化(含首次挂载)时用 rAF 弹簧过渡,展示层仍格式化整数分 */
export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number
  format: (value: number) => string
  className?: string
}) {
  const display = useSpringNumber(value)
  return <span className={className}>{format(display)}</span>
}
