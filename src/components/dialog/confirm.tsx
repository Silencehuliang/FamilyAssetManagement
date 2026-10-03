import { useCallback } from 'react'
import { useDialog } from './dialog'
import { PopupLayout } from './popup-layout'

export interface ConfirmOptions {
  title?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

/** promise 式确认框:await confirm('...') → true/false(替代 window.confirm) */
export function useConfirm(): (message: string, options?: ConfirmOptions) => Promise<boolean> {
  const { showDialog } = useDialog()
  return useCallback(
    (message: string, options: ConfirmOptions = {}) => {
      const title = options.title ?? '确认操作'
      return showDialog<boolean>(
        ({ close }) => (
          <PopupLayout title={title}>
            <p className="member-meta">{message}</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                className={options.danger ? 'danger-button' : 'primary-button'}
                onClick={() => close(true)}
              >
                {options.confirmText ?? '确认'}
              </button>
              <button type="button" className="link-button" onClick={() => close(false)}>
                {options.cancelText ?? '取消'}
              </button>
            </div>
          </PopupLayout>
        ),
        { label: title },
      )
    },
    [showDialog],
  )
}
