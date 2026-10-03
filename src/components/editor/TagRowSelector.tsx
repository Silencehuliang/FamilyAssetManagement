import MdiTagPlusOutline from '~icons/mdi/tag-plus-outline'
import type { TagGroup, TagId } from '../../domain'
import type { TagSelectionRow } from '../../features/tags'
import { TagChip } from '../tag'

/**
 * 标签选择:每组一行 chips(含合成的「未分组」行),行尾「标签管理」入口。
 * 单选组点选即替换、多选组切换、必选组不可清空最后一个(规则在 features/editor),
 * chip 用组色着色、选中态为实色。
 */
export function TagRowSelector({
  rows,
  selected,
  onToggle,
  onManage,
}: {
  rows: TagSelectionRow[]
  selected: readonly TagId[]
  onToggle: (group: TagGroup | null, tagId: TagId) => void
  onManage: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.group?.id ?? 'ungrouped'} className="flex items-start gap-2">
          <span className="mt-1.5 w-16 shrink-0 truncate text-xs text-muted-foreground">
            {row.label}
          </span>
          <div className="scrollbar-hidden flex flex-1 gap-2 overflow-x-auto pb-0.5">
            {row.tags.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                color={row.color}
                active={selected.includes(tag.id)}
                onClick={() => onToggle(row.group, tag.id)}
              />
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="text-button inline-flex items-center gap-1 self-end"
        onClick={onManage}
      >
        <MdiTagPlusOutline className="size-4" />
        标签管理
      </button>
    </div>
  )
}
