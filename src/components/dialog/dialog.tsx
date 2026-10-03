import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

export interface DialogControls<Result = void> {
  close: (result: Result) => void
}

export interface DialogOptions {
  /** 无障碍名称(role="dialog" 的 aria-label) */
  label?: string
  /** 面板追加类名 */
  className?: string
  /** 是否允许移动端边缘拖拽关闭,默认 true */
  swipeDismiss?: boolean
}

export type DialogRenderer<Result = void> = (controls: DialogControls<Result>) => ReactNode

export type ShowDialog = <Result = void>(
  render: DialogRenderer<Result>,
  options?: DialogOptions,
) => Promise<Result>

interface DialogApi {
  showDialog: ShowDialog
}

interface Entry {
  id: number
  depth: number
  render: DialogRenderer<unknown>
  resolve: (value: unknown) => void
  options: DialogOptions
  closing: boolean
}

const DialogApiContext = createContext<DialogApi | null>(null)
const DialogControlsContext = createContext<DialogControls<unknown> | null>(null)

/** promise 式对话框入口:showDialog(render) 返回关闭时解析的 Promise */
export function useDialog(): DialogApi {
  const context = useContext(DialogApiContext)
  if (!context) throw new Error('useDialog 必须在 DialogProvider 内使用')
  return context
}

/** 当前最近一层对话框的关闭句柄(PopupLayout 与内容组件使用) */
export function useDialogControls(): DialogControls<unknown> {
  const context = useContext(DialogControlsContext)
  if (!context) throw new Error('useDialogControls 必须在对话框内使用')
  return context
}

export const DIALOG_CLOSE_ANIMATION_MS = 400

/**
 * 对话框栈:portal 到 body,支持嵌套(父对话框不卸载)、Esc 关闭、
 * 移动端右侧滑入 + 边缘拖拽返回、桌面底部滑入;遮罩为面板上的巨型 box-shadow。
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const entriesRef = useRef<Entry[]>([])
  const nextId = useRef(1)

  const commit = useCallback((next: Entry[]) => {
    entriesRef.current = next
    setEntries(next)
  }, [])

  const showDialog = useCallback(
    function show<Result>(
      render: DialogRenderer<Result>,
      options: DialogOptions = {},
    ): Promise<Result> {
      const id = nextId.current
      nextId.current += 1
      return new Promise<Result>((resolve) => {
        const entry: Entry = {
          id,
          depth: entriesRef.current.length,
          render,
          resolve: resolve as (value: unknown) => void,
          options,
          closing: false,
        }
        commit([...entriesRef.current, entry])
      })
    },
    [commit],
  )

  const closeEntry = useCallback(
    (id: number, value: unknown) => {
      const current = entriesRef.current
      const entry = current.find((item) => item.id === id)
      if (!entry || entry.closing) return
      entry.resolve(value)
      commit(current.map((item) => (item.id === id ? { ...item, closing: true } : item)))
      window.setTimeout(() => {
        commit(entriesRef.current.filter((item) => item.id !== id))
      }, DIALOG_CLOSE_ANIMATION_MS)
    },
    [commit],
  )

  // 有对话框时锁定页面滚动
  useEffect(() => {
    if (entries.length === 0) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [entries.length])

  const api = useMemo<DialogApi>(() => ({ showDialog }), [showDialog])

  return (
    <DialogApiContext.Provider value={api}>
      {children}
      {createPortal(
        entries.map((entry, index) => (
          <DialogHost
            key={entry.id}
            entry={entry}
            isTop={index === entries.length - 1}
            onClose={closeEntry}
          />
        )),
        document.body,
      )}
    </DialogApiContext.Provider>
  )
}

function DialogHost({
  entry,
  isTop,
  onClose,
}: {
  entry: Entry
  isTop: boolean
  onClose: (id: number, value: unknown) => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startedAt: number
    dx: number
  } | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setMounted(true))
    return () => window.cancelAnimationFrame(raf)
  }, [])

  const controls = useMemo<DialogControls<unknown>>(
    () => ({ close: (result?: unknown) => onClose(entry.id, result) }),
    [entry.id, onClose],
  )

  useEffect(() => {
    if (!isTop) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      controls.close(undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controls, isTop])

  const canSwipe = entry.options.swipeDismiss !== false

  /** 移动端边缘拖拽返回:起始 clientX < 50 才接管;拖拽中忽略新的 pointerdown */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current) return
    if (!canSwipe || event.pointerType === 'mouse') return
    // 与 CSS 一致:≥640px 是底部滑入布局,右侧边缘拖拽仅移动端(右滑布局)生效
    if (window.innerWidth >= 640) return
    if (event.clientX >= 50) return
    const panel = panelRef.current
    if (!panel) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startedAt: performance.now(),
      dx: 0,
    }
    panel.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const panel = panelRef.current
    if (!drag || !panel || drag.pointerId !== event.pointerId) return
    drag.dx = Math.max(0, event.clientX - drag.startX)
    panel.style.transition = 'none'
    panel.style.transform = `translateX(${drag.dx}px)`
    panel.style.setProperty(
      '--dialog-overlay-scale',
      String(Math.max(0, 1 - drag.dx / Math.max(1, panel.offsetWidth))),
    )
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const panel = panelRef.current
    if (!drag || !panel || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    const elapsed = Math.max(1, performance.now() - drag.startedAt)
    const velocity = drag.dx / elapsed
    const shouldClose = drag.dx > panel.offsetWidth / 2 || velocity > 0.5
    if (shouldClose) {
      // 恢复 CSS 过渡(含 --dialog-overlay-scale),让面板滑出与遮罩变淡一起平滑收尾
      panel.style.transition = ''
      panel.style.transform = 'translateX(100%)'
      panel.style.setProperty('--dialog-overlay-scale', '0')
      onClose(entry.id, undefined)
      return
    }
    // 未过阈值:弹回原位
    panel.style.transition = ''
    panel.style.transform = ''
    panel.style.setProperty('--dialog-overlay-scale', '1')
  }

  const state = entry.closing ? 'closed' : mounted ? 'open' : 'closed'

  return (
    <div className="dialog-layer" data-state={state} data-nested={entry.depth > 0 ? '' : undefined}>
      <div
        ref={panelRef}
        className={
          entry.options.className ? `dialog-panel ${entry.options.className}` : 'dialog-panel'
        }
        role="dialog"
        aria-modal="true"
        aria-label={entry.options.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <DialogControlsContext.Provider value={controls}>
          {entry.render(controls)}
        </DialogControlsContext.Provider>
      </div>
    </div>
  )
}
