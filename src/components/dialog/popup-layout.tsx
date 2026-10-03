import type { ReactNode } from 'react'
import MdiChevronLeft from '~icons/mdi/chevron-left'
import { useDialogControls } from './dialog'

/**
 * 对话框统一外壳:左侧返回箭头(关闭)、居中标题、sticky + 毛玻璃头部,
 * 内容区自动避让安全区。所有 show*() 对话框都应以此包壳。
 */
export function PopupLayout({
  title,
  children,
  className,
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  const { close } = useDialogControls()
  return (
    <section className={className ? `dialog-body ${className}` : 'dialog-body'}>
      <header className="dialog-header">
        <button
          type="button"
          className="dialog-header-button"
          aria-label="关闭"
          onClick={() => close(undefined)}
        >
          <MdiChevronLeft className="size-6" />
        </button>
        <h2 className="dialog-header-title">{title}</h2>
        <span className="dialog-header-spacer" aria-hidden="true" />
      </header>
      <div className="dialog-content">{children}</div>
    </section>
  )
}
