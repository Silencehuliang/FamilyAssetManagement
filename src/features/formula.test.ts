import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT_CENTS } from '../domain/expenses'
import {
  canSaveFormula,
  display,
  editorKeyFromKeyboard,
  evaluate,
  type FormulaKey,
  type FormulaState,
  formulaAmountCents,
  formulaFromValue,
  initialFormula,
  MAX_FORMULA_LENGTH,
  moveCaret,
  pressKey,
  setCaret,
} from './formula'

/** 依次按键的便捷写法 */
function type(keys: string, start: FormulaState = initialFormula()): FormulaState {
  return keys.split('').reduce((state, key) => pressKey(state, key as FormulaKey), start)
}

describe('公式引擎:数字与小数点', () => {
  it('初始为空;依次按数字得到纯数字公式', () => {
    expect(display(initialFormula())).toBe('')
    expect(display(type('12'))).toBe('12')
    expect(evaluate(type('12'))).toBe(12)
  })

  it('前导零规整:单独的 0 被下一位数字替换,保留 0 与 0.', () => {
    expect(display(type('0'))).toBe('0')
    expect(display(type('05'))).toBe('5')
    expect(display(type('00'))).toBe('0')
    expect(display(type('0.5'))).toBe('0.5')
    expect(display(type('.5'))).toBe('0.5')
    expect(display(type('0.'))).toBe('0.')
  })

  it('小数点:每段至多一个;首字符为小数点自动补 0;每段小数 ≤3 位', () => {
    expect(display(type('1.2.3'))).toBe('1.23')
    expect(display(type('1.234'))).toBe('1.234')
    expect(display(type('1.2345'))).toBe('1.234') // 第 4 位小数被忽略
    expect(display(type('12.00'))).toBe('12.00')
    expect(display(type('.'))).toBe('0.')
  })

  it('小数位数上限对两个操作数分别生效', () => {
    expect(display(type('1.234+5.6789'))).toBe('1.234+5.678')
    expect(evaluate(type('1.234+5.678'))).toBeCloseTo(6.912, 5)
  })

  it('总长 ≤16 字符:超出后的输入被忽略', () => {
    const digits = '1234567890123456'
    expect(display(type(digits))).toBe(digits)
    expect(display(type(`${digits}7`))).toBe(digits) // 第 17 位被忽略

    const fifteen = '123456789012345'
    const withOp = type(`${fifteen}+`)
    expect(display(withOp)).toBe(`${fifteen}+`) // 15 位数字 + 运算符 = 16
    expect(display(pressKey(withOp, '1'))).toBe(`${fifteen}+`) // 已达上限,右操作数写不进去
    expect(display(type(`${digits}+`))).toBe(digits) // 16 位时运算符也写不进
  })
})

describe('公式引擎:运算符与求值', () => {
  it('加减乘除求值(显示用 − × ÷)', () => {
    expect(display(type('12+3'))).toBe('12+3')
    expect(evaluate(type('12+3'))).toBe(15)
    expect(evaluate(type('12−3'))).toBe(9)
    expect(evaluate(type('12×3'))).toBe(36)
    expect(evaluate(type('6÷4'))).toBe(1.5)
    expect(display(type('12−3'))).toBe('12−3')
    expect(display(type('12×3'))).toBe('12×3')
    expect(display(type('6÷4'))).toBe('6÷4')
  })

  it('连续运算符替换:尚未输入右操作数时不求值', () => {
    expect(display(type('12+−'))).toBe('12−')
    expect(display(type('12+×÷'))).toBe('12÷')
    expect(evaluate(type('12+'))).toBe(12) // 未完成的运算符,取值左边
  })

  it('输入第二个运算符时先求值再续写', () => {
    const state = type('12+3×')
    expect(display(state)).toBe('15×')
    expect(evaluate(state)).toBe(15)
    expect(display(pressKey(state, '2'))).toBe('15×2')
    expect(evaluate(pressKey(state, '2'))).toBe(30)
  })

  it('左操作数为空时运算符被忽略', () => {
    expect(display(type('+'))).toBe('')
    expect(display(type('×12'))).toBe('12') // 先按 × 被忽略,再输入数字
  })

  it('= 仅折叠显示为求值结果(运算结果在每次按键后已提交)', () => {
    expect(display(type('12+3='))).toBe('15')
    expect(evaluate(type('12+3='))).toBe(15)
    expect(display(type('6÷4='))).toBe('1.5')
    expect(display(type('1÷3='))).toBe('0.333')
    expect(display(type('2−5='))).toBe('-3')
    expect(display(type('12='))).toBe('12') // 纯数字不变
    expect(display(type('12+='))).toBe('12') // 未完成的运算符折叠为左值
    expect(display(type('1..5='))).toBe('1.5') // 折叠后仍是可继续计算的数字段
    expect(evaluate(type('1..5='))).toBe(1.5)
  })

  it('除以 0 不求值:结果 NaN,金额不可保存;= 不折叠', () => {
    const state = type('6÷0')
    expect(Number.isNaN(evaluate(state))).toBe(true)
    expect(display(pressKey(state, '='))).toBe('6÷0')
    expect(formulaAmountCents(state)).toBe(0)
  })
})

describe('公式引擎:退格 c', () => {
  it('逐字符删除;删到运算符时移除运算符;删空回到空公式', () => {
    expect(display(type('12+3c'))).toBe('12+')
    expect(display(type('12+3cc'))).toBe('12')
    expect(display(type('12+3ccc'))).toBe('1')
    expect(display(type('12+3cccc'))).toBe('')
    expect(display(type('12+3ccccc'))).toBe('')
    expect(display(type('.c'))).toBe('0')
    expect(display(type('.cc'))).toBe('')
    expect(display(type('0.c'))).toBe('0')
  })
})

describe('公式引擎:光标插入(#29 评审修复)', () => {
  it('数字插入在光标处(开头/中间/末尾),光标随插入右移', () => {
    const state = type('12+3') // 光标默认在末尾(4)
    const atOne = pressKey(setCaret(state, 1), '9')
    expect(display(atOne)).toBe('192+3') // 评审用例:index 1 插入 9
    expect(atOne.caret).toBe(2)
    expect(display(pressKey(setCaret(state, 0), '9'))).toBe('912+3') // 开头
    expect(display(pressKey(setCaret(state, 3), '9'))).toBe('12+93') // 右操作数前
    expect(display(pressKey(state, '9'))).toBe('12+39') // 末尾
  })

  it('光标落在运算符上:插入点在运算符之前,数字并入左操作数(文档化规则)', () => {
    const state = setCaret(type('12+3'), 2) // 光标停在 + 上
    const next = pressKey(state, '9')
    expect(display(next)).toBe('129+3')
    expect(next.caret).toBe(3)
    // 运算符右侧(右操作数开头)则并入右操作数
    expect(display(pressKey(setCaret(type('12+3'), 3), '9'))).toBe('12+93')
  })

  it('尚无运算符时运算符按光标拆分数字段;已有运算符沿用结构规则', () => {
    const twelve = type('12')
    expect(display(pressKey(twelve, '+'))).toBe('12+') // 末尾 = 原追加语义
    const split = pressKey(setCaret(twelve, 1), '+')
    expect(display(split)).toBe('1+2')
    expect(split.caret).toBe(2)
    expect(display(pressKey(setCaret(twelve, 0), '+'))).toBe('12') // 空左操作数 → 忽略
    expect(display(pressKey(setCaret(type('12+3'), 0), '×'))).toBe('15×') // 第二运算符求值
  })

  it('小数点按光标插入:前导补 0、段内去重、>3 位小数拒绝', () => {
    expect(display(pressKey(setCaret(type('12'), 1), '.'))).toBe('1.2')
    expect(display(pressKey(setCaret(type('1234'), 1), '.'))).toBe('1.234')
    expect(display(pressKey(setCaret(type('1234'), 2), '.'))).toBe('12.34')
    expect(display(pressKey(setCaret(type('1234'), 0), '.'))).toBe('1234') // 0.1234 有 4 位小数 → 拒绝
    expect(display(pressKey(setCaret(type('12.5'), 2), '.'))).toBe('12.5') // 已有小数点 → 拒绝
  })

  it('光标插入遵守前导零规整', () => {
    const five = pressKey(type('0'), '5')
    expect(display(five)).toBe('5') // 单独 0 被替换
    expect(five.caret).toBe(1)
    expect(display(pressKey(setCaret(type('0.5'), 0), '1'))).toBe('10.5')
    expect(display(pressKey(setCaret(type('12.34'), 2), '5'))).toBe('125.34')
  })
})

describe('公式引擎:光标退格与收敛(#29 评审修复)', () => {
  it('退格删除光标前一个字符;开头无操作;删除运算符时两侧数字并段', () => {
    const state = type('12+3')
    const atOne = pressKey(setCaret(state, 1), 'c')
    expect(display(atOne)).toBe('2+3')
    expect(atOne.caret).toBe(0)
    expect(display(pressKey(setCaret(state, 2), 'c'))).toBe('1+3') // 删除运算符前的数字
    expect(display(pressKey(setCaret(state, 3), 'c'))).toBe('123') // 删除运算符 → 并段
    expect(pressKey(setCaret(state, 3), 'c').caret).toBe(2)
    expect(display(pressKey(state, 'c'))).toBe('12+') // 末尾:删右操作数
    expect(display(pressKey(setCaret(state, 0), 'c'))).toBe('12+3') // 开头无操作
  })

  it('setCaret/moveCaret 越界收敛;折叠与退格后光标落在新文本内', () => {
    const state = type('12+3')
    expect(setCaret(state, 99).caret).toBe(4)
    expect(setCaret(state, -3).caret).toBe(0)
    expect(moveCaret(setCaret(state, 2), -1).caret).toBe(1)
    expect(moveCaret(state, 1).caret).toBe(4)

    const folded = pressKey(setCaret(state, 0), '×') // 第二运算符:先求值再续写
    expect(display(folded)).toBe('15×')
    expect(folded.caret).toBe(3) // 折叠后的运算符之后

    const equals = pressKey(setCaret(state, 0), '=')
    expect(display(equals)).toBe('15')
    expect(equals.caret).toBe(2) // = 折叠后光标到末尾

    expect(display(pressKey(type('12+'), 'c'))).toBe('12')
    expect(pressKey(type('12+'), 'c').caret).toBe(2)
  })
})

describe('公式引擎:评审补充边界(#29)', () => {
  it('未完成的运算符按左值求值:12+ → 12(1200 分)', () => {
    expect(evaluate(type('12+'))).toBe(12)
    expect(formulaAmountCents(type('12+'))).toBe(1200)
  })

  it("'0.' 求值为 0,'.5' 规整为 0.5(50 分)", () => {
    expect(display(type('0.'))).toBe('0.')
    expect(evaluate(type('0.'))).toBe(0)
    expect(display(type('.5'))).toBe('0.5')
    expect(formulaAmountCents(type('.5'))).toBe(50)
  })

  it('16 字符上限在任意光标位置都拒绝插入,光标不动', () => {
    const atCap = type('123456789012345+') // 15 位数字 + 运算符 = 16
    expect(display(atCap)).toBe('123456789012345+')
    const middle = setCaret(atCap, 7)
    const rejected = pressKey(middle, '9')
    expect(display(rejected)).toBe(display(atCap))
    expect(rejected.caret).toBe(7)
    // 前缀补 0 后会超长的小数点插入同样被拒
    expect(display(pressKey(setCaret(type('123456789012345'), 0), '.'))).toBe('123456789012345')
  })

  it('canSaveFormula:正、安全整数且 ≤ MAX_AMOUNT_CENTS;16 位数字溢出不可保存', () => {
    expect(canSaveFormula(initialFormula())).toBe(false)
    expect(canSaveFormula(type('0.001'))).toBe(false) // 不足一分 → 0 分
    expect(canSaveFormula(type('12+3'))).toBe(true)
    expect(canSaveFormula(type('9999999999999999'))).toBe(false) // ~1e18 分,非安全整数
    expect(formulaAmountCents(formulaFromValue(MAX_AMOUNT_CENTS / 100))).toBe(MAX_AMOUNT_CENTS)
    expect(canSaveFormula(formulaFromValue(MAX_AMOUNT_CENTS / 100))).toBe(true) // 上限边界
    expect(canSaveFormula(formulaFromValue(MAX_AMOUNT_CENTS / 100 + 0.01))).toBe(false) // 超上限
  })
})

describe('公式引擎:金额换算与预填', () => {
  it('求值为正且有限时换算为整数分;0/非法/除零给 0', () => {
    expect(formulaAmountCents(initialFormula())).toBe(0)
    expect(formulaAmountCents(type('0'))).toBe(0)
    expect(formulaAmountCents(type('12.5'))).toBe(1250)
    expect(formulaAmountCents(type('0.001'))).toBe(0) // 不足一分 → 不可保存
    expect(formulaAmountCents(type('0.005'))).toBe(1)
    expect(formulaAmountCents(type('6÷0'))).toBe(0)
  })

  it('formulaFromValue:编辑预填折叠为单个数字段(按分还原,去除多余尾零)', () => {
    expect(display(formulaFromValue(12.5))).toBe('12.5')
    expect(display(formulaFromValue(12))).toBe('12')
    expect(display(formulaFromValue(0.1))).toBe('0.1')
    expect(evaluate(formulaFromValue(12.5))).toBe(12.5)
  })
})

describe('公式引擎:物理键盘映射', () => {
  it('数字/运算符(含别名)/退格/Enter/r', () => {
    expect(editorKeyFromKeyboard('7')).toBe('7')
    expect(editorKeyFromKeyboard('.')).toBe('.')
    expect(editorKeyFromKeyboard('+')).toBe('+')
    expect(editorKeyFromKeyboard('-')).toBe('−')
    expect(editorKeyFromKeyboard('*')).toBe('×')
    expect(editorKeyFromKeyboard('/')).toBe('÷')
    expect(editorKeyFromKeyboard('×')).toBe('×')
    expect(editorKeyFromKeyboard('÷')).toBe('÷')
    expect(editorKeyFromKeyboard('=')).toBe('=')
    expect(editorKeyFromKeyboard('Backspace')).toBe('c')
    expect(editorKeyFromKeyboard('ArrowLeft')).toBe('left')
    expect(editorKeyFromKeyboard('ArrowRight')).toBe('right')
    expect(editorKeyFromKeyboard('Enter')).toBe('save')
    expect(editorKeyFromKeyboard('r')).toBe('again')
    expect(editorKeyFromKeyboard('R')).toBe('again')
    expect(editorKeyFromKeyboard('a')).toBeNull()
    expect(editorKeyFromKeyboard('Shift')).toBeNull()
  })

  it('物理键盘输入序列与键盘按键等价', () => {
    const viaKeyboard = ['1', '2', '3'].reduce(
      (state, key) => pressKey(state, editorKeyFromKeyboard(key) as '1'),
      initialFormula(),
    )
    expect(display(viaKeyboard)).toBe(display(type('123')))
  })
})

describe('公式引擎:不变量', () => {
  it('任意按键序列下显示长度 ≤16 且不出现连续运算符', () => {
    const keys = '++12..3+4×5÷6==cc7.891+2−3×4÷5'
    let state = initialFormula()
    for (const key of keys) {
      state = pressKey(state, key as FormulaKey)
      expect(display(state).length).toBeLessThanOrEqual(MAX_FORMULA_LENGTH)
      expect(/[+−×÷]{2}/.test(display(state))).toBe(false)
    }
  })
})
