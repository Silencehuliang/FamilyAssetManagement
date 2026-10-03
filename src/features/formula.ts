/**
 * 记账编辑器的计算器公式引擎(V7,纯函数):
 *
 * - 语法 `[Num] | [Num,Op] | [Num,Op,Num]`(`segments` 交替存数字段与运算符);
 * - 每段小数 ≤3 位、全部文本 ≤16 字符、前导零规整(保留 `0.`);
 * - 输入第二个运算符时先求值再续写;
 * - `=` 仅折叠显示;金额在每次按键后即可 `evaluate`,保存以求值结果为准;
 * - `c` 退格;数字/运算符/退格/Enter 的物理键映射见 `editorKeyFromKeyboard`。
 *
 * 运算符在 segments 里存显示符号(`+ − × ÷`),`display()` 直接拼接即为公式字符串。
 */
export const MAX_FORMULA_LENGTH = 16
export const MAX_DECIMALS = 3

export type FormulaKey =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '.'
  | '+'
  | '−'
  | '×'
  | '÷'
  | '='
  | 'c'

/** 物理键盘映射出的编辑器动作:公式键 + 保存(Enter) + 再记(r) */
export type EditorKey = FormulaKey | 'save' | 'again'

export interface FormulaState {
  /**
   * 交替的片段:下标偶数位是数字段,奇数位是运算符,如 `['12','+','3']`。
   * 初始为 `['']`(一个空数字段);运算符只在左操作数非空时可写入。
   */
  readonly segments: readonly string[]
}

const OPERATORS = ['+', '−', '×', '÷'] as const

function isOperator(segment: string): segment is (typeof OPERATORS)[number] {
  return (OPERATORS as readonly string[]).includes(segment)
}

export function initialFormula(): FormulaState {
  return { segments: [''] }
}

/** 编辑模式预填:把金额(元)折叠成一个数字段 */
export function formulaFromValue(value: number): FormulaState {
  const text = formatFormulaNumber(value)
  return { segments: [text === '' ? '0' : text] }
}

/** 公式字符串(原样,如 `12+3`);`=` 折叠后即求值结果 */
export function display(state: FormulaState): string {
  return state.segments.join('')
}

function decimalsOf(text: string): number {
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/** 数字段的末段下标;末段是运算符时返回 -1(数字段总在末尾或需要新建) */
function lastNumberIndex(segments: readonly string[]): number {
  const last = segments[segments.length - 1]
  return last !== undefined && !isOperator(last) ? segments.length - 1 : -1
}

/** 求值结果 → 展示文本(≤3 位小数,去尾零;非有限值返回空串) */
export function formatFormulaNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  const rounded = Math.round(value * 1000) / 1000
  let text = String(rounded)
  if (text.includes('e') || text.includes('E')) {
    text = rounded.toFixed(3).replace(/\.?0+$/, '')
  }
  return text
}

function applyOperator(left: number, op: string, right: number): number {
  switch (op) {
    case '+':
      return left + right
    case '−':
      return left - right
    case '×':
      return left * right
    case '÷':
      return right === 0 ? Number.NaN : left / right
    default:
      return Number.NaN
  }
}

/**
 * 求值:完整公式([Num,Op,Num])算出结果;只有左操作数(或带未完成的运算符)
 * 时返回左操作数值;空/非法按 0;除零与无法解析返回 NaN。
 */
export function evaluate(state: FormulaState): number {
  const [left = ''] = state.segments
  const leftValue = left === '' ? 0 : Number(left)
  if (Number.isNaN(leftValue)) return Number.NaN
  const op = state.segments[1]
  const right = state.segments[2]
  if (op !== undefined && right !== undefined) return applyOperator(leftValue, op, Number(right))
  return leftValue
}

/** 可保存的金额(整数分):求值为正且有限时四舍五入到分,否则 0(保存按钮禁用) */
export function formulaAmountCents(state: FormulaState): number {
  const value = evaluate(state)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value * 100)
}

function withSegments(segments: readonly string[]): FormulaState {
  return { segments }
}

function appendDigit(segments: readonly string[], digit: string): FormulaState {
  const parts = [...segments]
  let index = lastNumberIndex(parts)
  if (index < 0) {
    parts.push('')
    index = parts.length - 1
  }
  const current = parts[index] ?? ''
  if (decimalsOf(current) >= MAX_DECIMALS) return withSegments(segments)
  // 前导零规整:单独的 0 被下一位数字替换(保留 0. 与 0 本身)
  let next: string
  if (current === '0') next = digit
  else next = current + digit
  parts[index] = next
  if (parts.join('').length > MAX_FORMULA_LENGTH) return withSegments(segments)
  return withSegments(parts)
}

function appendDot(segments: readonly string[]): FormulaState {
  const parts = [...segments]
  let index = lastNumberIndex(parts)
  if (index < 0) {
    parts.push('')
    index = parts.length - 1
  }
  const current = parts[index] ?? ''
  if (current.includes('.')) return withSegments(segments)
  parts[index] = current === '' ? '0.' : `${current}.`
  if (parts.join('').length > MAX_FORMULA_LENGTH) return withSegments(segments)
  return withSegments(parts)
}

function pressOperator(segments: readonly string[], op: string): FormulaState {
  const parts = [...segments]
  if (parts.length === 1) {
    if ((parts[0] ?? '') === '') return withSegments(segments)
    parts.push(op)
    return parts.join('').length > MAX_FORMULA_LENGTH ? withSegments(segments) : withSegments(parts)
  }
  if (parts.length === 2) {
    parts[1] = op
    return withSegments(parts)
  }
  // [Num,Op,Num]:先求值再续写
  const value = evaluate(withSegments(parts))
  const formatted = formatFormulaNumber(value)
  if (formatted === '') return withSegments(segments)
  const next = [formatted, op]
  return next.join('').length > MAX_FORMULA_LENGTH ? withSegments(segments) : withSegments(next)
}

function pressEquals(segments: readonly string[]): FormulaState {
  if (segments.length === 1) return withSegments(segments)
  if (segments.length === 2) return withSegments([segments[0] ?? ''])
  const formatted = formatFormulaNumber(evaluate({ segments }))
  if (formatted === '') return withSegments(segments)
  return withSegments([formatted])
}

function pressBackspace(segments: readonly string[]): FormulaState {
  const parts = [...segments]
  if (parts.length === 0) return initialFormula()
  const index = parts.length - 1
  const last = parts[index] ?? ''
  const shortened = last.slice(0, -1)
  if (shortened === '') {
    if (parts.length === 1) parts[0] = ''
    else parts.pop()
  } else {
    parts[index] = shortened
  }
  return withSegments(parts)
}

/** 处理一次按键,返回新状态;被精度/长度/语法规则拒绝时返回原状态 */
export function pressKey(state: FormulaState, key: FormulaKey): FormulaState {
  if (key >= '0' && key <= '9' && key.length === 1) return appendDigit(state.segments, key)
  switch (key) {
    case '.':
      return appendDot(state.segments)
    case '+':
    case '−':
    case '×':
    case '÷':
      return pressOperator(state.segments, key)
    case '=':
      return pressEquals(state.segments)
    case 'c':
      return pressBackspace(state.segments)
    default:
      return state
  }
}

/** 物理键盘事件 key → 编辑器动作;不能识别返回 null(输入框内的按键由调用方先过滤) */
export function editorKeyFromKeyboard(key: string): EditorKey | null {
  if (key >= '0' && key <= '9' && key.length === 1) return key as FormulaKey
  switch (key) {
    case '.':
      return '.'
    case '+':
      return '+'
    case '-':
    case '−':
      return '−'
    case '*':
    case '×':
      return '×'
    case '/':
    case '÷':
      return '÷'
    case '=':
      return '='
    case 'Backspace':
      return 'c'
    case 'Enter':
      return 'save'
    case 'r':
    case 'R':
      return 'again'
    default:
      return null
  }
}
