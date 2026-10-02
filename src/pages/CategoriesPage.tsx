import { useState } from 'react'
import type { Category } from '../domain'
import { DomainError } from '../domain/types'
import {
  canManageCategories,
  categoryInUse,
  categoryTree,
  countExpensesInCategory,
  migrationTargets,
} from '../features/categories'
import type { AppController, AppState } from '../state/app-controller'

type CategoryDialog =
  | { mode: 'add-parent' }
  | { mode: 'add-child'; parentId: string; parentName: string }
  | { mode: 'rename'; category: Category }

interface MigrationState {
  category: Category
  targets: Category[]
  targetId: string
}

function errorText(err: unknown): string {
  if (err instanceof DomainError || err instanceof Error) return err.message
  return '操作失败,请重试'
}

/**
 * 分类管理(T8):两级分类的增/改/删,父分类先于子分类;
 * 删除仍有支出的子分类时必须选择同父下的迁移目标(领域层强制)。
 * 普通成员只读;所有变更经 AppController 写穿并同步,成员设备在合并时采纳远端版本。
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

  const [dialog, setDialog] = useState<CategoryDialog | null>(null)
  const [name, setName] = useState('')
  const [migrating, setMigrating] = useState<MigrationState | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const openDialog = (next: CategoryDialog, initialName = ''): void => {
    setDialog(next)
    setName(initialName)
    setFeedback(null)
  }

  const submitDialog = (): void => {
    if (!dialog) return
    setBusy(true)
    setFeedback(null)
    const run =
      dialog.mode === 'add-parent'
        ? controller.addCategory({ name })
        : dialog.mode === 'add-child'
          ? controller.addCategory({ name, parentId: dialog.parentId })
          : controller.updateCategory(dialog.category.id, { name })
    void run
      .then(() => {
        setDialog(null)
        setFeedback({ kind: 'ok', text: '已保存' })
      })
      .catch((err: unknown) => {
        setFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const runDelete = (id: string, migrateToId?: string): void => {
    setBusy(true)
    setFeedback(null)
    void controller
      .deleteCategory(id, migrateToId)
      .then(() => {
        setMigrating(null)
        setFeedback({ kind: 'ok', text: '已删除' })
      })
      .catch((err: unknown) => {
        setFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const requestDelete = (category: Category): void => {
    setFeedback(null)
    const node = tree.find((item) => item.parent.id === category.id)
    if (category.parentId === undefined && node && node.children.length > 0) {
      setFeedback({ kind: 'error', text: '该分类下仍有子分类,请先删除或迁走子分类' })
      return
    }
    if (category.parentId !== undefined && categoryInUse(ledger, category.id)) {
      const targets = migrationTargets(ledger, category.id)
      if (targets.length === 0) {
        setFeedback({ kind: 'error', text: '同父下没有可迁移的目标分类,请先新增一个子分类' })
        return
      }
      const first = targets[0]
      if (!first) return
      setMigrating({ category, targets, targetId: first.id })
      return
    }
    if (!window.confirm(`删除分类「${category.name}」?`)) return
    runDelete(category.id)
  }

  const dialogTitle =
    dialog?.mode === 'add-parent'
      ? '添加父分类'
      : dialog?.mode === 'add-child'
        ? `在「${dialog.parentName}」下添加子分类`
        : dialog?.mode === 'rename'
          ? `重命名「${dialog.category.name}」`
          : ''

  return (
    <div className="page">
      <button type="button" className="link-button back-button" onClick={onBack}>
        ← 返回
      </button>

      <section className="card">
        <h2 className="card-title">分类管理</h2>
        <p className="member-meta">
          {canManage
            ? '两级分类:每笔支出归属一个子分类;删除仍有支出的子分类时需选择迁移目标。'
            : '仅管理员可修改分类,你可以查看当前分类体系。'}
        </p>
      </section>

      {feedback ? (
        <p className={feedback.kind === 'ok' ? 'form-success' : 'form-error'}>{feedback.text}</p>
      ) : null}

      {dialog ? (
        <section className="card">
          <h2 className="card-title">{dialogTitle}</h2>
          <label className="field">
            <span>名称</span>
            <input
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
            onClick={submitDialog}
          >
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" className="link-button" onClick={() => setDialog(null)}>
            取消
          </button>
        </section>
      ) : null}

      {tree.map((node) => (
        <section className="card" key={node.parent.id}>
          <div className="category-row">
            <strong className="category-name">{node.parent.name}</strong>
            {canManage ? (
              <div className="row-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    openDialog({
                      mode: 'add-child',
                      parentId: node.parent.id,
                      parentName: node.parent.name,
                    })
                  }
                >
                  加子类
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    openDialog({ mode: 'rename', category: node.parent }, node.parent.name)
                  }
                >
                  改名
                </button>
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => requestDelete(node.parent)}
                >
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
                        className="text-button"
                        onClick={() => openDialog({ mode: 'rename', category: child }, child.name)}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        className="text-button danger-text"
                        onClick={() => requestDelete(child)}
                      >
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
          className="primary-button"
          onClick={() => openDialog({ mode: 'add-parent' })}
        >
          + 添加父分类
        </button>
      ) : null}

      {migrating ? (
        <div className="sheet-backdrop">
          <section className="sheet" aria-label="迁移分类">
            <h2 className="card-title">迁移后删除</h2>
            <p className="member-meta">
              「{migrating.category.name}」下仍有{' '}
              {countExpensesInCategory(ledger, migrating.category.id)} 笔支出,请选择迁移到的子分类。
            </p>
            <label className="field">
              <span>迁移到</span>
              <select
                value={migrating.targetId}
                onChange={(event) =>
                  setMigrating((current) =>
                    current ? { ...current, targetId: event.target.value } : current,
                  )
                }
              >
                {migrating.targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => runDelete(migrating.category.id, migrating.targetId)}
            >
              {busy ? '迁移中…' : '确认迁移并删除'}
            </button>
            <button type="button" className="link-button" onClick={() => setMigrating(null)}>
              取消
            </button>
          </section>
        </div>
      ) : null}
    </div>
  )
}
