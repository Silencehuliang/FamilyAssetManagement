import { useState } from 'react'
import { toast } from 'sonner'
import MdiArrowLeft from '~icons/mdi/arrow-left'
import MdiDeleteOutline from '~icons/mdi/delete-outline'
import MdiPencilOutline from '~icons/mdi/pencil-outline'
import MdiPlus from '~icons/mdi/plus'
import { PopupLayout, useConfirm, useDialog } from '../components/dialog'
import type { Category } from '../domain'
import {
  canManageCategories,
  categoryInUse,
  categoryTree,
  countExpensesInCategory,
  migrationTargets,
} from '../features/categories'
import { errorText } from '../lib/errors'
import type { AppController, AppState } from '../state/app-controller'

type CategoryDialog =
  | { mode: 'add-parent' }
  | { mode: 'add-child'; parentId: string; parentName: string }
  | { mode: 'rename'; category: Category }

function dialogTitle(dialog: CategoryDialog): string {
  if (dialog.mode === 'add-parent') return '添加父分类'
  if (dialog.mode === 'add-child') return `在「${dialog.parentName}」下添加子分类`
  return `重命名「${dialog.category.name}」`
}

/**
 * 分类管理(T8):两级分类的增/改/删,父分类先于子分类;
 * 删除仍有支出的子分类时必须选择同父下的迁移目标(领域层强制)。
 * 普通成员只读;所有变更经 AppController 写穿并同步,成员设备在合并时采纳远端版本。
 * 所有表单走 promise 对话框体系(V2),结果以 toast 反馈。
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
  const { showDialog } = useDialog()
  const confirm = useConfirm()

  const openCategoryForm = (dialog: CategoryDialog, initialName = ''): void => {
    void showDialog<void>(
      ({ close }) => (
        <CategoryFormDialog
          controller={controller}
          dialog={dialog}
          initialName={initialName}
          onClose={() => close(undefined)}
        />
      ),
      { label: dialogTitle(dialog) },
    )
  }

  const runDelete = (id: string, migrateToId?: string): void => {
    void controller
      .deleteCategory(id, migrateToId)
      .then(() => {
        toast.success('已删除')
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
  }

  const requestDelete = (category: Category): void => {
    const node = tree.find((item) => item.parent.id === category.id)
    if (category.parentId === undefined && node && node.children.length > 0) {
      toast.error('该分类下仍有子分类,请先删除或迁走子分类')
      return
    }
    if (category.parentId !== undefined && categoryInUse(ledger, category.id)) {
      const targets = migrationTargets(ledger, category.id)
      if (targets.length === 0) {
        toast.error('同父下没有可迁移的目标分类,请先新增一个子分类')
        return
      }
      const first = targets[0]
      if (!first) return
      void showDialog<void>(
        ({ close }) => (
          <MigrationDialog
            controller={controller}
            ledger={ledger}
            category={category}
            targets={targets}
            initialTargetId={first.id}
            onClose={() => close(undefined)}
          />
        ),
        { label: '迁移分类' },
      )
      return
    }
    void confirm(`删除分类「${category.name}」?`, {
      title: '删除分类',
      confirmText: '删除',
      danger: true,
    }).then((ok) => {
      if (ok) runDelete(category.id)
    })
  }

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
            ? '两级分类:每笔支出归属一个子分类;删除仍有支出的子分类时需选择迁移目标。'
            : '仅管理员可修改分类,你可以查看当前分类体系。'}
        </p>
      </section>

      {tree.map((node) => (
        <section className="card" key={node.parent.id}>
          <div className="category-row">
            <strong className="category-name">{node.parent.name}</strong>
            {canManage ? (
              <div className="row-actions">
                <button
                  type="button"
                  className="text-button inline-flex items-center gap-0.5"
                  onClick={() =>
                    openCategoryForm({
                      mode: 'add-child',
                      parentId: node.parent.id,
                      parentName: node.parent.name,
                    })
                  }
                >
                  <MdiPlus className="size-4" />
                  加子类
                </button>
                <button
                  type="button"
                  className="text-button inline-flex items-center gap-0.5"
                  onClick={() =>
                    openCategoryForm({ mode: 'rename', category: node.parent }, node.parent.name)
                  }
                >
                  <MdiPencilOutline className="size-4" />
                  改名
                </button>
                <button
                  type="button"
                  className="text-button danger-text inline-flex items-center gap-0.5"
                  onClick={() => requestDelete(node.parent)}
                >
                  <MdiDeleteOutline className="size-4" />
                  删除
                </button>
              </div>
            ) : null}
          </div>
          {node.children.length === 0 ? (
            <p className="member-meta">暂无子分类</p>
          ) : (
            <ul className="category-children">
              {node.children.map((child) => (
                <li key={child.id} className="category-child-row">
                  <span>{child.name}</span>
                  {canManage ? (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="text-button inline-flex items-center gap-0.5"
                        onClick={() =>
                          openCategoryForm({ mode: 'rename', category: child }, child.name)
                        }
                      >
                        <MdiPencilOutline className="size-4" />
                        改名
                      </button>
                      <button
                        type="button"
                        className="text-button danger-text inline-flex items-center gap-0.5"
                        onClick={() => requestDelete(child)}
                      >
                        <MdiDeleteOutline className="size-4" />
                        删除
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {canManage ? (
        <button
          type="button"
          className="primary-button inline-flex items-center justify-center gap-1"
          onClick={() => openCategoryForm({ mode: 'add-parent' })}
        >
          <MdiPlus className="size-4" />
          添加父分类
        </button>
      ) : null}
    </div>
  )
}

/** 新增父/子分类或改名;保存成功 toast 并关闭 */
function CategoryFormDialog({
  controller,
  dialog,
  initialName,
  onClose,
}: {
  controller: AppController
  dialog: CategoryDialog
  initialName: string
  onClose: () => void
}) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    setBusy(true)
    const run =
      dialog.mode === 'add-parent'
        ? controller.addCategory({ name })
        : dialog.mode === 'add-child'
          ? controller.addCategory({ name, parentId: dialog.parentId })
          : controller.updateCategory(dialog.category.id, { name })
    void run
      .then(() => {
        toast.success('已保存')
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <PopupLayout title={dialogTitle(dialog)}>
      <label className="field">
        <span>名称</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: 对话框唯一输入,自动聚焦是刻意行为
          autoFocus
          type="text"
          value={name}
          placeholder="如 咖啡"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={name.trim() === '' || busy}
        onClick={submit}
      >
        {busy ? '保存中…' : '保存'}
      </button>
    </PopupLayout>
  )
}

/** 有支出的子分类:先选迁移目标再删除 */
function MigrationDialog({
  controller,
  ledger,
  category,
  targets,
  initialTargetId,
  onClose,
}: {
  controller: AppController
  ledger: AppState['ledger']
  category: Category
  targets: Category[]
  initialTargetId: string
  onClose: () => void
}) {
  const [targetId, setTargetId] = useState(initialTargetId)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    setBusy(true)
    void controller
      .deleteCategory(category.id, targetId)
      .then(() => {
        toast.success('已迁移并删除')
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <PopupLayout title="迁移后删除">
      <p className="member-meta">
        「{category.name}」下仍有 {countExpensesInCategory(ledger, category.id)}{' '}
        笔支出,请选择迁移到的子分类。
      </p>
      <label className="field mt-3">
        <span>迁移到</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="primary-button" disabled={busy} onClick={submit}>
        {busy ? '迁移中…' : '确认迁移并删除'}
      </button>
    </PopupLayout>
  )
}
