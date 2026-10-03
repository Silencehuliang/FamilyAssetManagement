import type { Tag, TagColor } from '../../domain'
import { TAG_CHIP_ACTIVE_CLASS, TAG_CHIP_CLASS } from '../../features/tags'

/**
 * 标签 chip:`#名称` + 组色着色(未分组用中性灰)。
 * 管理界面里点击进入编辑;记账编辑器里点击切换选中(active)。
 */
export function TagChip({
  tag,
  color,
  active = false,
  className,
  onClick,
}: {
  tag: Tag
  color: TagColor
  active?: boolean
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-[13px] leading-none ${
        active ? TAG_CHIP_ACTIVE_CLASS[color] : TAG_CHIP_CLASS[color]
      } ${className ?? ''}`}
      onClick={onClick}
    >
      #{tag.name}
    </button>
  )
}
