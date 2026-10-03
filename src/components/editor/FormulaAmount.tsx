import { Fragment, useRef } from 'react'
import { display, type FormulaState } from '../../features/formula'

/** WebKit/Blink 非标准 API 与 Firefox 标准 API 的统一形状 */
type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
}

/** Range API 给出的插入点 → 字符下标;落在具体字符 span 上时按下标 + 文本偏移换算 */
function caretIndexFromRange(x: number, y: number, root: HTMLElement | null): number | null {
  if (!root) return null
  const doc = document as CaretDocument
  let range = doc.caretRangeFromPoint?.(x, y) ?? null
  if (!range) {
    const position = doc.caretPositionFromPoint?.(x, y) ?? null
    if (!position) return null
    range = document.createRange()
    range.setStart(position.offsetNode, position.offset)
    range.collapse(true)
  }
  if (!root.contains(range.startContainer)) return null
  const node = range.startContainer
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const span = element?.closest<HTMLElement>('[data-char-index]')
  if (!span || !root.contains(span)) return null
  const base = Number(span.dataset.charIndex)
  if (!Number.isFinite(base)) return null
  const offset = node.nodeType === Node.TEXT_NODE ? Math.min(range.startOffset, 1) : 0
  return base + offset
}

/**
 * 顶部大字金额:公式原文按字符渲染,点按把光标放到字符之间
 * (优先 caretRangeFromPoint/caretPositionFromPoint,回退到字符 span 的左右半区)。
 * 光标是闪烁细竖条(#29):数字/退格都在光标处生效,左右方向键移动光标。
 */
export function FormulaAmount({
  formula,
  onCaret,
}: {
  formula: FormulaState
  onCaret: (index: number) => void
}) {
  const text = display(formula)
  const caret = Math.min(Math.max(formula.caret, 0), text.length)
  const chars = [...text]
  const textRef = useRef<HTMLSpanElement | null>(null)

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const fromRange = caretIndexFromRange(event.clientX, event.clientY, textRef.current)
    if (fromRange !== null) {
      onCaret(fromRange)
      return
    }
    // 回退:命中哪个字符 span,就按点击在字符的左/右半区决定插入点
    const target = event.target
    const element =
      target instanceof Element ? target : document.elementFromPoint(event.clientX, event.clientY)
    const span = element?.closest<HTMLElement>('[data-char-index]')
    if (span && textRef.current?.contains(span)) {
      const index = Number(span.dataset.charIndex)
      if (Number.isFinite(index)) {
        const rect = span.getBoundingClientRect()
        onCaret(event.clientX < rect.left + rect.width / 2 ? index : index + 1)
        return
      }
    }
    onCaret(text.length)
  }

  return (
    <button
      type="button"
      aria-label="金额公式,点按放置光标"
      className="block w-full min-h-16 cursor-text rounded-lg border-0 bg-secondary/60 px-3 py-2 text-right"
      onClick={handleClick}
    >
      {text === '' ? (
        <span className="text-3xl text-muted-foreground">0.00</span>
      ) : (
        <span ref={textRef} className="text-4xl font-bold break-all tabular-nums">
          {chars.map((char, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 公式按位置渲染,重复字符只有下标能唯一标识
            <Fragment key={`${index}-${char}`}>
              {caret === index ? <Caret /> : null}
              <span data-char-index={index}>{char}</span>
            </Fragment>
          ))}
          {caret === text.length ? <Caret /> : null}
        </span>
      )}
    </button>
  )
}

/** 闪烁的细竖条(置于字符之间,不参与点击命中的字符 span) */
function Caret() {
  return (
    <span
      className="mx-px inline-block h-8 w-0.5 translate-y-1 animate-pulse bg-primary align-middle"
      aria-hidden="true"
    />
  )
}
