import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Expense, TagGroup, TagId } from '../../domain'
import {
  buildEditorExpenseInput,
  buildEditorExpensePatch,
  draftForAgain,
  draftForNew,
  draftFromExpense,
  type EditorDraft,
  editorCategories,
  selectParentCategory,
  toggleTagSelection,
} from '../../features/editor'
import { todayKey } from '../../features/entry'
import {
  editorKeyFromKeyboard,
  type FormulaKey,
  formulaAmountCents,
  pressKey,
} from '../../features/formula'
import { tagSelectionRows } from '../../features/tags'
import { errorText } from '../../lib/errors'
import type { AppController } from '../../state/app-controller'
import { useAppState } from '../../state/use-app'
import { PopupLayout, useConfirm } from '../dialog'
import { useTagManager } from '../tag'
import { CategoryGrid } from './CategoryGrid'
import { FormulaAmount } from './FormulaAmount'
import { Keypad } from './Keypad'
import { TagRowSelector } from './TagRowSelector'

/**
 * 全屏记账编辑器(V7):公式金额 + 计算器键盘 + 两级分类 + 每组一行标签。
 * - 新单:保存 / 再记(保存后仅保留日期开新单);编辑:预填 + 保存 / 删除;
 * - 物理键盘:数字/运算符/退格/Enter 保存/r 再记(输入框聚焦时不接管);
 * - 保存失败留在框内可重试;成功 toast。
 */
export function BillEditorDialog({
  controller,
  expense,
  onClose,
}: {
  controller: AppController
  expense?: Expense
  onClose: () => void
}) {
  const state = useAppState(controller)
  const ledger = state.ledger
  const confirm = useConfirm()
  const openTagManager = useTagManager(controller)
  const memberId = state.member?.id ?? ''

  const [draft, setDraft] = useState<EditorDraft>(() =>
    expense
      ? draftFromExpense(ledger, expense, memberId)
      : draftForNew(ledger, memberId, todayKey()),
  )
  const [caret, setCaret] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const savingRef = useRef(false)

  const amountCents = formulaAmountCents(draft.formula)
  const canSave = amountCents > 0 && !busy
  const rows = tagSelectionRows(ledger)
  const categories = editorCategories(ledger)

  const save = useCallback(
    (again: boolean): void => {
      if (savingRef.current || formulaAmountCents(draft.formula) <= 0) return
      savingRef.current = true
      setBusy(true)
      try {
        const action = expense
          ? controller.patchExpense(expense.id, buildEditorExpensePatch(ledger, draft))
          : controller.addExpense(buildEditorExpenseInput(ledger, draft))
        void action
          .then(() => {
            toast.success(expense ? '已保存修改' : '已记下这笔')
            if (again && !expense) {
              // 再记:存掉当前笔,开新单仅保留日期
              setDraft(draftForAgain(ledger, memberId, draft.date))
              setCaret(null)
            } else {
              onClose()
            }
          })
          .catch((err: unknown) => {
            toast.error(errorText(err))
          })
          .finally(() => {
            savingRef.current = false
            setBusy(false)
          })
      } catch (err) {
        // 草稿校验(金额/日期/分类)同步抛错:留在框内提示,不进入保存态
        savingRef.current = false
        setBusy(false)
        toast.error(errorText(err))
      }
    },
    [controller, draft, expense, ledger, memberId, onClose],
  )

  // 物理键盘:数字/运算符/退格/Enter 保存/r 再记;输入框聚焦时交给输入框
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      // 嵌套对话框(如标签管理)在最上层时,不把按键路由到编辑器
      const layers = document.querySelectorAll('.dialog-layer')
      const top = layers[layers.length - 1]
      if (!top?.querySelector('[data-bill-editor]')) return
      const action = editorKeyFromKeyboard(event.key)
      if (!action) return
      event.preventDefault()
      if (action === 'save') {
        save(false)
        return
      }
      if (action === 'again') {
        if (!expense) save(true)
        return
      }
      setDraft((current) => ({ ...current, formula: pressKey(current.formula, action) }))
      setCaret(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expense, save])

  const pressKeypad = (key: FormulaKey): void => {
    setDraft((current) => ({ ...current, formula: pressKey(current.formula, key) }))
    setCaret(null)
  }

  const toggleTag = (group: TagGroup | null, tagId: TagId): void => {
    setDraft((current) => ({
      ...current,
      tagIds: toggleTagSelection(group, tagId, current.tagIds),
    }))
  }

  const remove = (): void => {
    if (!expense) return
    void confirm('删除这笔支出?删除会同步到所有设备。', {
      title: '删除支出',
      confirmText: '删除',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void controller
        .deleteExpense(expense.id)
        .then(() => {
          toast.success('已删除')
          onClose()
        })
        .catch((err: unknown) => {
          toast.error(errorText(err))
          setBusy(false)
        })
    })
  }

  const allMembers = state.members.length > 0 ? state.members : state.member ? [state.member] : []
  const memberOptions = allMembers.filter((m) => !m.disabled || m.id === draft.memberId)

  return (
    <PopupLayout title={expense ? '编辑支出' : '记一笔'}>
      <div data-bill-editor className="flex min-h-full flex-col gap-3">
        <FormulaAmount formula={draft.formula} caret={caret} onCaret={setCaret} />

        <CategoryGrid
          categories={categories}
          parentId={draft.parentId}
          categoryId={draft.categoryId}
          onSelectParent={(parentId) =>
            setDraft((current) => ({
              ...current,
              parentId,
              categoryId: selectParentCategory(ledger, current.categoryId, parentId),
            }))
          }
          onSelectChild={(categoryId) => setDraft((current) => ({ ...current, categoryId }))}
        />

        <TagRowSelector
          rows={rows}
          selected={draft.tagIds}
          onToggle={toggleTag}
          onManage={openTagManager}
        />

        <div className="grid grid-cols-2 gap-2">
          <label className={`field mb-0 ${memberOptions.length > 1 ? '' : 'col-span-2'}`}>
            <span>日期</span>
            <input
              type="date"
              value={draft.date}
              onChange={(event) =>
                setDraft((current) => ({ ...current, date: event.target.value }))
              }
            />
          </label>
          {memberOptions.length > 1 ? (
            <label className="field mb-0">
              <span>经手人</span>
              <select
                value={draft.memberId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, memberId: event.target.value }))
                }
              >
                {memberOptions.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                    {member.id === memberId ? '(我)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <label className="field mb-0">
          <span>备注(可选)</span>
          <input
            type="text"
            placeholder="如 楼下超市"
            value={draft.note}
            onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
          />
        </label>

        {expense ? (
          <button type="button" className="danger-button" disabled={busy} onClick={remove}>
            删除这笔
          </button>
        ) : null}

        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-auto flex flex-col gap-2 border-t border-border bg-card/95 px-4 pt-3 pb-4 backdrop-blur">
          <button
            type="button"
            className="primary-button"
            disabled={!canSave}
            onClick={() => save(false)}
          >
            {busy ? '保存中…' : expense ? '保存修改' : '保存'}
          </button>
          <Keypad
            onKey={pressKeypad}
            onAgain={() => save(true)}
            canSave={canSave}
            showAgain={!expense}
            busy={busy}
          />
        </div>
      </div>
    </PopupLayout>
  )
}
