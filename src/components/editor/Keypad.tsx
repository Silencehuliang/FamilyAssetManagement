import MdiBackspaceOutline from '~icons/mdi/backspace-outline'
import type { FormulaKey } from '../../features/formula'

export type KeypadKey = FormulaKey | 'again'

const ROWS: FormulaKey[][] = [
  ['7', '8', '9', '÷'],
  ['4', '5', '6', '×'],
  ['1', '2', '3', '−'],
  ['.', '0', 'c', '+'],
]

const OPERATOR_KEYS = new Set(['÷', '×', '−', '+'])

function keyClass(key: KeypadKey): string {
  const base =
    'flex h-13 min-h-[52px] items-center justify-center rounded-lg border border-border text-xl font-medium tabular-nums select-none active:scale-[0.97]'
  if (key === 'c') return `${base} text-destructive`
  if (OPERATOR_KEYS.has(key)) return `${base} bg-secondary text-foreground`
  return `${base} bg-card text-foreground`
}

/**
 * 计算器键盘:数字 3 列 + 运算符列,底行「再记」(新单可见)与「=」。
 * `=` 仅折叠显示(求值在每次按键已提交);再记 = 保存当前笔并立即开新单。
 */
export function Keypad({
  onKey,
  onAgain,
  canSave,
  showAgain,
  busy,
}: {
  onKey: (key: FormulaKey) => void
  onAgain: () => void
  canSave: boolean
  showAgain: boolean
  busy: boolean
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {ROWS.flat().map((key) => (
        <button
          key={key}
          type="button"
          data-key={key}
          aria-label={key === 'c' ? '退格' : key}
          className={keyClass(key)}
          disabled={busy}
          onClick={() => onKey(key)}
        >
          {key === 'c' ? <MdiBackspaceOutline className="size-6" /> : key}
        </button>
      ))}
      {showAgain ? (
        <button
          type="button"
          data-key="again"
          className="col-span-2 flex h-13 min-h-[52px] items-center justify-center rounded-lg border border-border bg-secondary text-[15px] font-semibold text-secondary-foreground active:scale-[0.97]"
          disabled={busy || !canSave}
          onClick={onAgain}
        >
          再记
        </button>
      ) : null}
      <button
        type="button"
        data-key="="
        aria-label="等于"
        className={`flex h-13 min-h-[52px] items-center justify-center rounded-lg border-0 bg-primary text-xl font-semibold text-primary-foreground active:scale-[0.97] ${
          showAgain ? 'col-span-2' : 'col-span-4'
        }`}
        disabled={busy || !canSave}
        onClick={() => onKey('=')}
      >
        =
      </button>
    </div>
  )
}
