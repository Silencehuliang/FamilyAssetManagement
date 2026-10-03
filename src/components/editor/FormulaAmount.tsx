import { useRef } from 'react'
import { display, type FormulaState } from '../../features/formula'

/** WebKit/Blink 非标准 API(Firefox 用标准的 caretPositionFromPoint) */
type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

/**
 * 顶部大字金额:显示公式原文(如 `12+3`),点按可把光标放到字符之间。
 * 说明(V7 记录在案的简化):光标索引只做展示与定位,后续按键仍从公式末尾续写
 * (端插式);把字符插入任意位置的代价高、收益低,故未做中插编辑。
 */
export function FormulaAmount({
  formula,
  caret,
  onCaret,
}: {
  formula: FormulaState
  caret: number | null
  onCaret: (index: number | null) => void
}) {
  const text = display(formula)
  const textRef = useRef<HTMLSpanElement | null>(null)

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const doc = document as CaretDocument
    const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null
    if (range && textRef.current?.contains(range.startContainer)) {
      onCaret(Math.min(range.startOffset, text.length))
      return
    }
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY) ?? null
    if (
      position &&
      textRef.current?.contains(document.elementFromPoint(event.clientX, event.clientY))
    ) {
      onCaret(Math.min(position.offset, text.length))
      return
    }
    onCaret(text.length)
  }

  const before = caret === null ? text : text.slice(0, caret)
  const after = caret === null ? '' : text.slice(caret)

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
          {before}
          {caret !== null ? <Caret /> : null}
          {after}
        </span>
      )}
    </button>
  )
}

function Caret() {
  return (
    <span
      className="mx-px inline-block h-8 w-0.5 translate-y-1 animate-pulse bg-primary align-middle"
      aria-hidden="true"
    />
  )
}
