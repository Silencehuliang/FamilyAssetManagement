/**
 * 记账编辑器的计算器公式引擎(V7,纯函数):
 *
 * - 语法 `[Num] | [Num,Op] | [Num,Op,Num]`(`segments` 交替存数字段与运算符);
 * - 每段小数 ≤3 位、全部文本 ≤16 字符、前导零规整(保留 `0.`);
 * - 输入第二个运算符时先求值再续写;
 * - `=` 仅折叠显示;金额在每次按键后即可 `evaluate`,保存以求值结果为准;
 * - `c` 退格;数字/运算符/退格/方向键/Enter 的物理键映射见 `editorKeyFromKeyboard`。
 *
 * 光标模型(#29 评审修复):`caret` 是公式字符串下标(0..len),表示插入点。
 * - 数字/小数点插入在光标处,插入后光标右移一位;光标落在运算符字符上时,
 *   插入点仍在运算符之前 —— 数字并入左操作数(`12+3` 光标停在 `+` 上按 9 → `129+3`);
 * - 尚无运算符时,运算符键按光标位置拆分数字段插入(`12` 光标 1 按 `+` → `1+2`);
 *   已有运算符时沿用结构规则(替换未完成运算符 / 第二运算符先求值),光标落到新公式末尾;
 * - 退格删除光标前一个字符(删除运算符会把两侧数字并段);`=` 折叠后光标到末尾;
 * - 每次变更后光标都收敛到 0..len,越界的光标由 `setCaret` / `moveCaret` 主动收敛。
 *
 * 运算符在 segments 里存显示符号(`+ − × ÷`),`display()` 直接拼接即为公式字符串。
 */
import { isValidAmountCents } from '../domain/expenses'

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

/** 物理键盘映射出的编辑器动作:公式键 + 保存(Enter) + 再记(r) + 光标左右(方向键) */
export type EditorKey = FormulaKey | 'save' | 'again' | 'left' | 'right'

export interface FormulaState {
  /**
   * 交替的片段:下标偶数位是数字段,奇数位是运算符,如 `['12','+','3']`。
   * 初始为 `['']`(一个空数字段);运算符只在左操作数非空时可写入。
   */
  readonly segments: readonly string[]
  /** 插入点下标 0..display(state).length;位置 i 表示插入点在第 i 个字符之前 */
  readonly caret: number
}

const OPERATORS = ['+', '−', '×', '÷'] as const
const OPERAND_RE = /^\d+(\.\d*)?$/

function isOperator(segment: string): segment is (typeof OPERATORS)[number] {
  return (OPERATORS as readonly string[]).includes(segment)
}

function isDigitChar(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

export function initialFormula(): FormulaState {
  return { segments: [''], caret: 0 }
}

/** 编辑模式预填:把金额(元)折叠成一个数字段,光标停在末尾 */
export function formulaFromValue(value: number): FormulaState {
  const text = formatFormulaNumber(value)
  const normalized = text === '' ? '0' : text
  return { segments: [normalized], caret: normalized.length }
}

/** 公式字符串(原样,如 `12+3`);`=` 折叠后即求值结果 */
export function display(state: FormulaState): string {
  return state.segments.join('')
}

/** 光标收敛到 0..length;非有限值按 0 */
function clampCaret(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(Math.trunc(index), 0), length)
}

/** 把光标放到指定下标(自动收敛到 0..len) */
export function setCaret(state: FormulaState, index: number): FormulaState {
  const caret = clampCaret(index, display(state).length)
  return caret === state.caret ? state : { ...state, caret }
}

/** 光标左右移动(方向键;delta 为 -1/1) */
export function moveCaret(state: FormulaState, delta: number): FormulaState {
  return setCaret(state, state.caret + delta)
}

function decimalsOf(text: string): number {
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
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

/**
 * 保存谓词(界面按钮与保存入口共用):换算为分后是合法金额 ——
 * >0、安全整数且 ≤ MAX_AMOUNT_CENTS;16 位数字换算会溢出安全整数,在此拦下。
 */
export function canSaveFormula(state: FormulaState): boolean {
  return isValidAmountCents(formulaAmountCents(state))
}

/** 光标在段内的偏移(walk 用) */
interface OperandCursor {
  /** 规范化后的段文本 */
  text: string
  /** 段内光标偏移(随规范化平移) */
  offset: number
}

/**
 * 规范化单个操作数:以 `.` 开头时补前导 0(`.5` → `0.5`);0 后直接跟数字时
 * 去掉前导 0(`05` → `5`、`00` → `0`)。光标偏移随补/删的字符平移。
 * 非法(空、多小数点、>3 位小数)返回 null。
 */
function normalizeOperand(operand: string, offset: number): OperandCursor | null {
  let text = operand
  let at = offset
  if (text.startsWith('.')) {
    text = `0${text}`
    at += 1
  }
  while (text.length >= 2 && text[0] === '0' && isDigitChar(text[1])) {
    text = text.slice(1)
    if (at > 0) at -= 1
  }
  if (!OPERAND_RE.test(text) || decimalsOf(text) > MAX_DECIMALS) return null
  return { text, offset: at }
}

/**
 * 候选公式 → 新状态(插入/删除/拆分的统一入口):逐段校验与规范化,
 * 光标映射到新文本;违反语法/精度/长度(≤16)任一条即返回 null,调用方保持原状态。
 */
function applyCandidate(candidate: string, caret: number): FormulaState | null {
  if (candidate === '') return { segments: [''], caret: 0 }
  const parts = candidate.split(/([+−×÷])/)
  // `12+` 这类以运算符结尾的中间态在 split 结果里多一个空段,丢弃
  if (parts.length > 1 && (parts[parts.length - 1] ?? '') === '') parts.pop()
  const segments: string[] = []
  let length = 0
  let nextCaret = caret
  let mapped = false
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? ''
    if (i % 2 === 1) {
      if (!isOperator(part)) return null
      segments.push(part)
      length += part.length
      continue
    }
    const start = length
    const end = start + part.length
    const affected = !mapped && caret >= start && caret <= end
    const normalized = normalizeOperand(part, affected ? caret - start : 0)
    if (normalized === null) return null
    if (affected) {
      nextCaret = start + normalized.offset
      mapped = true
    }
    segments.push(normalized.text)
    length += normalized.text.length
  }
  if (!mapped) nextCaret = length
  if (length > MAX_FORMULA_LENGTH) return null
  return { segments, caret: clampCaret(nextCaret, length) }
}

/**
 * 在光标处插入一个字符(数字或小数点)。
 * 光标落在运算符字符上时插入点仍在运算符之前,因此数字并入左操作数(文档化规则)。
 */
function insertAtCaret(state: FormulaState, char: string): FormulaState {
  const text = display(state)
  const caret = clampCaret(state.caret, text.length)
  const candidate = text.slice(0, caret) + char + text.slice(caret)
  return applyCandidate(candidate, caret + char.length) ?? setCaret(state, caret)
}

/**
 * 运算符键(结构性规则,保持 V7 语义):
 * - 已有运算符:替换未完成的运算符;`[Num,Op,Num]` 先求值再续写,光标落到新公式末尾;
 * - 尚无运算符:按光标位置拆分数字段插入(`12` 光标 1 按 `+` → `1+2`,光标在 `+` 后);
 *   拆出空左操作数(光标在开头)时忽略,与「左操作数为空时运算符被忽略」一致。
 */
function pressOperator(state: FormulaState, op: string): FormulaState {
  const text = display(state)
  const caret = clampCaret(state.caret, text.length)
  if (state.segments.length === 1) {
    const candidate = text.slice(0, caret) + op + text.slice(caret)
    return applyCandidate(candidate, caret + op.length) ?? setCaret(state, caret)
  }
  if (state.segments.length === 2) {
    const candidate = `${state.segments[0] ?? ''}${op}`
    return applyCandidate(candidate, candidate.length) ?? setCaret(state, caret)
  }
  const formatted = formatFormulaNumber(evaluate(state))
  if (formatted === '') return setCaret(state, caret)
  return applyCandidate(`${formatted}${op}`, formatted.length + op.length) ?? setCaret(state, caret)
}

/** `=` 折叠:未完成运算符折叠为左值;完整公式折叠为求值结果;光标到末尾 */
function pressEquals(state: FormulaState): FormulaState {
  const caret = clampCaret(state.caret, display(state).length)
  if (state.segments.length <= 1) return setCaret(state, caret)
  if (state.segments.length === 2) {
    const left = state.segments[0] ?? ''
    return { segments: [left], caret: left.length }
  }
  const formatted = formatFormulaNumber(evaluate(state))
  if (formatted === '') return setCaret(state, caret)
  return { segments: [formatted], caret: formatted.length }
}

/** 退格:删除光标前一个字符;结果破坏语法时保持原状态(光标仍收敛) */
function pressBackspace(state: FormulaState): FormulaState {
  const text = display(state)
  const caret = clampCaret(state.caret, text.length)
  if (caret === 0) return setCaret(state, 0)
  const candidate = text.slice(0, caret - 1) + text.slice(caret)
  return applyCandidate(candidate, caret - 1) ?? setCaret(state, caret)
}

/** 处理一次按键,返回新状态;被精度/长度/语法规则拒绝时保持原状态(光标收敛) */
export function pressKey(state: FormulaState, key: FormulaKey): FormulaState {
  if (isDigitChar(key) && key.length === 1) return insertAtCaret(state, key)
  switch (key) {
    case '.':
      return insertAtCaret(state, '.')
    case '+':
    case '−':
    case '×':
    case '÷':
      return pressOperator(state, key)
    case '=':
      return pressEquals(state)
    case 'c':
      return pressBackspace(state)
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
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'Enter':
      return 'save'
    case 'r':
    case 'R':
      return 'again'
    default:
      return null
  }
}
