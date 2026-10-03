import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import MdiArrowLeft from '~icons/mdi/arrow-left'
import MdiDeleteOutline from '~icons/mdi/delete-outline'
import MdiDragVertical from '~icons/mdi/drag-vertical'
import MdiPencilOutline from '~icons/mdi/pencil-outline'
import MdiPlus from '~icons/mdi/plus'
import { useConfirm } from '../components/dialog'
import { type Category, TAG_PALETTE, type TagColor } from '../domain'
import {
  CATEGORY_COLOR_VARS,
  canManageCategories,
  categoryColor,
  categoryInUse,
  categoryTree,
  countExpensesInCategory,
  migrationTargets,
} from '../features/categories'
import { errorText } from '../lib/errors'
import type { AppController, AppState } from '../state/app-controller'

const COLOR_LABELS: Record<TagColor, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  gray: '灰',
}

type EditTarget =
  | { kind: 'add-parent' }
  | { kind: 'add-child'; parentId: string }
  | { kind: 'rename'; categoryId: string }

interface MigrationState {
  categoryId: string
  targetId: string
}

interface NoticeState {
  categoryId: string
  text: string
}

/** 长按 200ms 起拖(移动端触控);鼠标同样按住约 200ms,避免与点击编辑冲突 */
function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )
}

/**
 * 分类管理(V8 重做):两级分类的就地编辑(加子类/改名/删除)、拖拽排序与父分类配色。
 * - 编辑输入框在目标行原位展开(自动聚焦并滚入视野),Enter 提交,Esc/失焦取消;
 * - 父分类之间与同一父下的子分类之间用 dnd-kit 拖拽排序(长按起拖),写回 sortOrder;
 * - 删除仍有支出的子分类时,迁移目标选择在该行内完成;父分类有子类时行内拒绝;
 * - 父分类色经 categoryColor 统一流向明细与首页;普通成员只读。
 */
export function CategoriesPage({
  controller,
  state,
  onBack,
}: {
  controller: AppController
  state: AppState
  onBack: () => void
}) {
  const ledger = state.ledger
  const canManage = canManageCategories(state.member)
  const tree = categoryTree(ledger)
  const confirm = useConfirm()
  const sensors = useDragSensors()

  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [migrating, setMigrating] = useState<MigrationState | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [paletteFor, setPaletteFor] = useState<string | null>(null)

  const fail = (err: unknown): void => {
    toast.error(errorText(err))
  }

  const commitName = async (name: string): Promise<void> => {
    if (!editing) return
    try {
      if (editing.kind === 'add-parent') {
        await controller.addCategory({ name })
      } else if (editing.kind === 'add-child') {
        await controller.addCategory({ name, parentId: editing.parentId })
      } else {
        await controller.updateCategory(editing.categoryId, { name })
      }
      setEditing(null)
      toast.success('已保存')
    } catch (err) {
      fail(err)
    }
  }

  const runDelete = (category: Category): void => {
    void controller
      .deleteCategory(category.id)
      .then(() => {
        toast.success('已删除')
      })
      .catch(fail)
  }

  const requestDelete = (category: Category): void => {
    setNotice(null)
    setPaletteFor(null)
    const node = tree.find((item) => item.parent.id === category.id)
    if (category.parentId === undefined && node && node.children.length > 0) {
      setNotice({ categoryId: category.id, text: '该分类下仍有子分类,请先删除或迁走子分类' })
      return
    }
    if (category.parentId !== undefined && categoryInUse(ledger, category.id)) {
      const targets = migrationTargets(ledger, category.id)
      const first = targets[0]
      if (!first) {
        setNotice({
          categoryId: category.id,
          text: '同父下没有可迁移的目标分类,请先新增一个子分类',
        })
        return
      }
      setMigrating({ categoryId: category.id, targetId: first.id })
      return
    }
    void confirm(`删除分类「${category.name}」?`, {
      title: '删除分类',
      confirmText: '删除',
      danger: true,
    }).then((ok) => {
      if (ok) runDelete(category)
    })
  }

  const submitMigration = (category: Category, targetId: string): void => {
    void controller
      .deleteCategory(category.id, targetId)
      .then(() => {
        setMigrating(null)
        toast.success('已迁移并删除')
      })
      .catch(fail)
  }

  const selectMigrationTarget = (categoryId: string, targetId: string): void => {
    setMigrating((current) =>
      current && current.categoryId === categoryId ? { ...current, targetId } : current,
    )
  }

  const chooseColor = (category: Category, color: TagColor): void => {
    setPaletteFor(null)
    void controller
      .updateCategory(category.id, { color })
      .then(() => {
        toast.success('颜色已更新')
      })
      .catch(fail)
  }

  const reorderSiblings = (parentId: string | null, orderedIds: string[]): void => {
    void controller.reorderCategories(parentId, orderedIds).catch(fail)
  }

  const onParentDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = tree.map((node) => node.parent.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    reorderSiblings(null, arrayMove(ids, from, to))
  }

  const parentIds = tree.map((node) => node.parent.id)

  return (
    <div className="page">
      <button
        type="button"
        className="link-button back-button inline-flex items-center gap-1"
        onClick={onBack}
      >
        <MdiArrowLeft className="size-4" />
        返回
      </button>

      <section className="card">
        <h2 className="card-title">分类管理</h2>
        <p className="member-meta">
          {canManage
            ? '两级分类:每笔支出归属一个子分类;点「改名/加子类」在原地编辑,长按拖拽排序;删除仍有支出的子分类时需选择迁移目标。'
            : '仅管理员可修改分类,你可以查看当前分类体系。'}
        </p>
      </section>

      {tree.length === 0 ? (
        <section className="placeholder-card">
          <p className="placeholder-title">还没有分类</p>
          <p className="placeholder-note">先添加一个父分类,再往下加子分类。</p>
        </section>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onParentDragEnd}
        >
          <SortableContext items={parentIds} strategy={verticalListSortingStrategy}>
            {tree.map((node) => (
              <ParentCard
                key={node.parent.id}
                ledger={ledger}
                node={node}
                canManage={canManage}
                editing={editing}
                migrating={migrating}
                notice={notice}
                paletteFor={paletteFor}
                onStartEdit={setEditing}
                onCancelEdit={() => setEditing(null)}
                onCommitName={commitName}
                onRequestDelete={requestDelete}
                onSubmitMigration={submitMigration}
                onSelectMigrationTarget={selectMigrationTarget}
                onCancelMigration={() => setMigrating(null)}
                onTogglePalette={(id) => setPaletteFor((current) => (current === id ? null : id))}
                onClosePalette={() => setPaletteFor(null)}
                onChooseColor={chooseColor}
                onReorderChildren={(parentId, orderedIds) => reorderSiblings(parentId, orderedIds)}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

      {canManage ? (
        editing?.kind === 'add-parent' ? (
          <InlineNameInput
            placeholder="父分类名称,如 咖啡"
            submitLabel="添加"
            onSubmit={commitName}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button
            type="button"
            className="primary-button inline-flex items-center justify-center gap-1"
            onClick={() => {
              setNotice(null)
              setEditing({ kind: 'add-parent' })
            }}
          >
            <MdiPlus className="size-4" />
            添加父分类
          </button>
        )
      ) : null}
    </div>
  )
}

function ParentCard({
  ledger,
  node,
  canManage,
  editing,
  migrating,
  notice,
  paletteFor,
  onStartEdit,
  onCancelEdit,
  onCommitName,
  onRequestDelete,
  onSubmitMigration,
  onSelectMigrationTarget,
  onCancelMigration,
  onTogglePalette,
  onClosePalette,
  onChooseColor,
  onReorderChildren,
}: {
  ledger: AppState['ledger']
  node: ReturnType<typeof categoryTree>[number]
  canManage: boolean
  editing: EditTarget | null
  migrating: MigrationState | null
  notice: NoticeState | null
  paletteFor: string | null
  onStartEdit: (target: EditTarget) => void
  onCancelEdit: () => void
  onCommitName: (name: string) => Promise<void>
  onRequestDelete: (category: Category) => void
  onSubmitMigration: (category: Category, targetId: string) => void
  onSelectMigrationTarget: (categoryId: string, targetId: string) => void
  onCancelMigration: () => void
  onTogglePalette: (id: string) => void
  onClosePalette: () => void
  onChooseColor: (category: Category, color: TagColor) => void
  onReorderChildren: (parentId: string, orderedIds: string[]) => void
}) {
  const parent = node.parent
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: parent.id,
    disabled: !canManage,
  })
  const renaming = editing?.kind === 'rename' && editing.categoryId === parent.id
  const addingChild = editing?.kind === 'add-child' && editing.parentId === parent.id
  const cardNotice = notice?.categoryId === parent.id ? notice.text : null

  return (
    <section
      ref={setNodeRef}
      className={`card category-card ${isDragging ? 'category-dragging' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      <div className="category-row">
        {canManage ? (
          <button
            type="button"
            className="drag-handle"
            aria-label={`拖动排序「${parent.name}」`}
            {...attributes}
            {...listeners}
          >
            <MdiDragVertical className="size-5" />
          </button>
        ) : null}
        <ParentSwatch
          category={parent}
          color={categoryColor(ledger, parent.id)}
          open={paletteFor === parent.id}
          canManage={canManage}
          onToggle={() => onTogglePalette(parent.id)}
          onClose={onClosePalette}
          onChoose={(color) => onChooseColor(parent, color)}
        />
        {renaming ? (
          <div className="min-w-0 flex-1">
            <InlineNameInput
              initialValue={parent.name}
              compact
              onSubmit={onCommitName}
              onCancel={onCancelEdit}
            />
          </div>
        ) : (
          <strong className="category-name min-w-0 flex-1 truncate">{parent.name}</strong>
        )}
        {canManage && !renaming ? (
          <div className="row-actions">
            <button
              type="button"
              className="text-button inline-flex items-center gap-0.5"
              onClick={() => {
                onClosePalette()
                onStartEdit({ kind: 'add-child', parentId: parent.id })
              }}
            >
              <MdiPlus className="size-4" />
              加子类
            </button>
            <button
              type="button"
              className="text-button inline-flex items-center gap-0.5"
              onClick={() => onStartEdit({ kind: 'rename', categoryId: parent.id })}
            >
              <MdiPencilOutline className="size-4" />
              改名
            </button>
            <button
              type="button"
              className="text-button danger-text inline-flex items-center gap-0.5"
              onClick={() => onRequestDelete(parent)}
            >
              <MdiDeleteOutline className="size-4" />
              删除
            </button>
          </div>
        ) : null}
      </div>
      {cardNotice ? <p className="form-error category-notice">{cardNotice}</p> : null}

      <ChildSortableList
        ledger={ledger}
        parentId={parent.id}
        items={node.children}
        canManage={canManage}
        editing={editing}
        migrating={migrating}
        notice={notice}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onCommitName={onCommitName}
        onRequestDelete={onRequestDelete}
        onSubmitMigration={onSubmitMigration}
        onSelectMigrationTarget={onSelectMigrationTarget}
        onCancelMigration={onCancelMigration}
        onReorder={onReorderChildren}
      />

      {canManage && addingChild ? (
        <div className="category-inline-row">
          <InlineNameInput
            placeholder="子分类名称,如 拿铁"
            submitLabel="添加"
            onSubmit={onCommitName}
            onCancel={onCancelEdit}
          />
        </div>
      ) : null}
    </section>
  )
}

/** 父分类色板:色块按钮 + 7 色弹出选择(子分类继承父分类色,只读展示) */
function ParentSwatch({
  category,
  color,
  open,
  canManage,
  onToggle,
  onClose,
  onChoose,
}: {
  category: Category
  color: string
  open: boolean
  canManage: boolean
  onToggle: () => void
  onClose: () => void
  onChoose: (color: TagColor) => void
}) {
  return (
    <div className="relative">
      <button
        type="button"
        className="color-swatch"
        style={{ background: color }}
        aria-label={`选择「${category.name}」的颜色`}
        aria-expanded={open}
        disabled={!canManage}
        onClick={onToggle}
      />
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-20 cursor-default bg-transparent"
            aria-label="关闭颜色选择"
            onClick={onClose}
          />
          <div className="color-palette" role="listbox" aria-label="分类颜色">
            {TAG_PALETTE.map((item) => (
              <button
                key={item}
                type="button"
                role="option"
                aria-selected={category.color === item}
                aria-label={COLOR_LABELS[item]}
                className={`color-option ${category.color === item ? 'color-option-active' : ''}`}
                style={{ background: CATEGORY_COLOR_VARS[item] }}
                onClick={() => onChoose(item)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

function ChildSortableList({
  ledger,
  parentId,
  items,
  canManage,
  editing,
  migrating,
  notice,
  onStartEdit,
  onCancelEdit,
  onCommitName,
  onRequestDelete,
  onSubmitMigration,
  onSelectMigrationTarget,
  onCancelMigration,
  onReorder,
}: {
  ledger: AppState['ledger']
  parentId: string
  items: Category[]
  canManage: boolean
  editing: EditTarget | null
  migrating: MigrationState | null
  notice: NoticeState | null
  onStartEdit: (target: EditTarget) => void
  onCancelEdit: () => void
  onCommitName: (name: string) => Promise<void>
  onRequestDelete: (category: Category) => void
  onSubmitMigration: (category: Category, targetId: string) => void
  onSelectMigrationTarget: (categoryId: string, targetId: string) => void
  onCancelMigration: () => void
  onReorder: (parentId: string, orderedIds: string[]) => void
}) {
  const sensors = useDragSensors()
  const ids = items.map((child) => child.id)

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    onReorder(parentId, arrayMove(ids, from, to))
  }

  if (items.length === 0 && !(canManage && editing?.kind === 'add-child')) {
    return <p className="member-meta">暂无子分类</p>
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="category-children">
          {items.map((child) => (
            <SortableChildRow
              key={child.id}
              ledger={ledger}
              child={child}
              canManage={canManage}
              renaming={editing?.kind === 'rename' && editing.categoryId === child.id}
              migrating={migrating?.categoryId === child.id ? migrating : null}
              notice={notice?.categoryId === child.id ? notice.text : null}
              onStartEdit={onStartEdit}
              onCancelEdit={onCancelEdit}
              onCommitName={onCommitName}
              onRequestDelete={onRequestDelete}
              onSubmitMigration={onSubmitMigration}
              onSelectMigrationTarget={onSelectMigrationTarget}
              onCancelMigration={onCancelMigration}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function SortableChildRow({
  ledger,
  child,
  canManage,
  renaming,
  migrating,
  notice,
  onStartEdit,
  onCancelEdit,
  onCommitName,
  onRequestDelete,
  onSubmitMigration,
  onSelectMigrationTarget,
  onCancelMigration,
}: {
  ledger: AppState['ledger']
  child: Category
  canManage: boolean
  renaming: boolean
  migrating: MigrationState | null
  notice: string | null
  onStartEdit: (target: EditTarget) => void
  onCancelEdit: () => void
  onCommitName: (name: string) => Promise<void>
  onRequestDelete: (category: Category) => void
  onSubmitMigration: (category: Category, targetId: string) => void
  onSelectMigrationTarget: (categoryId: string, targetId: string) => void
  onCancelMigration: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: child.id,
    disabled: !canManage,
  })
  const targets = migrating ? migrationTargets(ledger, child.id) : []

  return (
    <li
      ref={setNodeRef}
      className={`category-child-row ${isDragging ? 'category-dragging' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      {migrating ? (
        <div className="category-migrate">
          <p className="member-meta">
            「{child.name}」下仍有 {countExpensesInCategory(ledger, child.id)} 笔支出,迁移到:
          </p>
          <div className="category-migrate-controls">
            <select
              value={migrating.targetId}
              aria-label="迁移目标"
              onChange={(event) => onSelectMigrationTarget(child.id, event.target.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="text-button danger-text"
              onClick={() => onSubmitMigration(child, migrating.targetId)}
            >
              确认迁移并删除
            </button>
            <button type="button" className="text-button" onClick={onCancelMigration}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          {canManage ? (
            <button
              type="button"
              className="drag-handle"
              aria-label={`拖动排序「${child.name}」`}
              {...attributes}
              {...listeners}
            >
              <MdiDragVertical className="size-4" />
            </button>
          ) : null}
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: categoryColor(ledger, child.id) }}
            aria-hidden="true"
          />
          {renaming ? (
            <div className="min-w-0 flex-1">
              <InlineNameInput
                initialValue={child.name}
                compact
                onSubmit={onCommitName}
                onCancel={onCancelEdit}
              />
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate">{child.name}</span>
          )}
          {canManage && !renaming ? (
            <span className="row-actions">
              <button
                type="button"
                className="text-button inline-flex items-center gap-0.5"
                onClick={() => onStartEdit({ kind: 'rename', categoryId: child.id })}
              >
                <MdiPencilOutline className="size-4" />
                改名
              </button>
              <button
                type="button"
                className="text-button danger-text inline-flex items-center gap-0.5"
                onClick={() => onRequestDelete(child)}
              >
                <MdiDeleteOutline className="size-4" />
                删除
              </button>
            </span>
          ) : null}
        </>
      )}
      {notice ? <p className="form-error category-notice">{notice}</p> : null}
    </li>
  )
}

/**
 * 就地编辑输入框:挂载时自动聚焦并滚入视野;Enter 提交,Esc 取消,
 * 失焦取消(焦点移到输入框容器内的按钮时不取消,保证可点「保存」)。
 */
function InlineNameInput({
  initialValue = '',
  placeholder,
  submitLabel = '保存',
  compact = false,
  onSubmit,
  onCancel,
}: {
  initialValue?: string
  placeholder?: string
  submitLabel?: string
  compact?: boolean
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}): ReactNode {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.scrollIntoView({ block: 'nearest' })
  }, [])

  const submit = (): void => {
    const name = value.trim()
    if (name === '' || busy) return
    setBusy(true)
    void onSubmit(name).finally(() => setBusy(false))
  }

  return (
    <span ref={wrapperRef} className="inline-edit">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        className={compact ? 'inline-edit-input inline-edit-input-compact' : 'inline-edit-input'}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onBlur={(event) => {
          if (busy) return
          const next = event.relatedTarget as Node | null
          if (next && wrapperRef.current?.contains(next)) return
          onCancel()
        }}
      />
      <button
        type="button"
        className="text-button font-medium"
        disabled={value.trim() === '' || busy}
        onClick={submit}
      >
        {submitLabel}
      </button>
      <button type="button" className="text-button" onClick={onCancel}>
        取消
      </button>
    </span>
  )
}
