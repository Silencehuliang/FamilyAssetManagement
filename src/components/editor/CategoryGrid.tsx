import type { Category, CategoryId } from '../../domain'
import { groupCategories } from '../../features/entry'

/**
 * 两级分类网格:父分类一行,子分类一行。
 * 点父分类:当前选中已属于其子分类时保持选择,否则选其第一个子分类;
 * 点子分类直接选中。父分类无子分类时(理论上不存在)子网格为空、保存被校验拦下。
 */
export function CategoryGrid({
  categories,
  parentId,
  categoryId,
  onSelectParent,
  onSelectChild,
}: {
  categories: Category[]
  parentId: CategoryId
  categoryId: CategoryId
  onSelectParent: (parentId: CategoryId) => void
  onSelectChild: (childId: CategoryId) => void
}) {
  const { parents, childrenByParent } = groupCategories(categories)
  const active = parents.find((item) => item.id === parentId) ?? parents[0]
  const children = active ? (childrenByParent[active.id] ?? []) : []

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-2">
        {parents.map((item) => {
          const selectedParent = active?.id === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selectedParent}
              className={`rounded-lg border px-1 py-2.5 text-[13px] leading-tight ${
                selectedParent
                  ? 'border-primary bg-primary font-semibold text-primary-foreground'
                  : 'border-border bg-card text-foreground'
              }`}
              onClick={() => onSelectParent(item.id)}
            >
              {item.name}
            </button>
          )
        })}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {children.map((item) => {
          const selectedChild = item.id === categoryId
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selectedChild}
              className={`rounded-lg border px-1 py-2 text-xs leading-tight ${
                selectedChild
                  ? 'border-primary bg-primary/10 font-semibold text-primary'
                  : 'border-border bg-background text-muted-foreground'
              }`}
              onClick={() => onSelectChild(item.id)}
            >
              {item.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
