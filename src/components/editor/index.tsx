import { useCallback } from 'react'
import type { Expense } from '../../domain'
import type { AppController } from '../../state/app-controller'
import { useDialog } from '../dialog'
import { BillEditorDialog } from './BillEditorDialog'

export { BillEditorDialog } from './BillEditorDialog'
export { CategoryGrid } from './CategoryGrid'
export { FormulaAmount } from './FormulaAmount'
export { Keypad, type KeypadKey } from './Keypad'
export { TagRowSelector } from './TagRowSelector'

/** 打开记账编辑器:移动端全屏;≥640px 居中面板(600px 宽 / 85vh 高) */
export function useBillEditor(
  controller: AppController,
): (options?: { expense?: Expense }) => Promise<void> {
  const { showDialog } = useDialog()
  return useCallback(
    (options: { expense?: Expense } = {}) => {
      const expense = options.expense
      return showDialog<void>(
        ({ close }) => (
          <BillEditorDialog
            controller={controller}
            expense={expense}
            onClose={() => close(undefined)}
          />
        ),
        {
          label: expense ? '编辑支出' : '记一笔',
          className: 'sm:max-w-[600px] sm:max-h-[85vh]',
        },
      )
    },
    [controller, showDialog],
  )
}
