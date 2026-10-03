import { useState } from 'react'
import { toast } from 'sonner'
import type { Expense } from '../domain'
import { DomainError } from '../domain/types'
import { expenseToForm } from '../features/entries'
import type { AppController, AppState } from '../state/app-controller'
import { PopupLayout, useConfirm } from './dialog'
import { ExpenseForm, type ExpenseFormValues } from './ExpenseForm'

function errorText(err: unknown): string {
  if (err instanceof DomainError || err instanceof Error) return err.message
  return '操作失败,请重试'
}

/**
 * 支出编辑对话框(明细页与首页账单流共用):保存/删除成功 toast 并关闭;
 * 失败留在框内可重试。V7 全屏编辑器接入后由新编辑器替换。
 */
export function EditExpenseDialog({
  controller,
  state,
  expense,
  onClose,
}: {
  controller: AppController
  state: AppState
  expense: Expense
  onClose: () => void
}) {
  const [values, setValues] = useState<ExpenseFormValues>(() =>
    expenseToForm(state.ledger, expense),
  )
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const save = (resolved: { categoryId: string; memberId: string }): void => {
    setBusy(true)
    void controller
      .updateExpense(expense.id, { ...values, ...resolved })
      .then(() => {
        toast.success('已保存修改')
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const remove = (): void => {
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
        })
        .finally(() => {
          setBusy(false)
        })
    })
  }

  return (
    <PopupLayout title="编辑支出">
      <ExpenseForm
        categories={state.ledger.meta.categories}
        members={state.members}
        currentMemberId={state.member?.id}
        values={values}
        onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
        onSubmit={save}
        submitLabel="保存修改"
        submitting={busy}
        footer={
          <button type="button" className="danger-button" disabled={busy} onClick={remove}>
            删除这笔
          </button>
        }
      />
    </PopupLayout>
  )
}
