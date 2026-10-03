import { describe, expect, it } from 'vitest'
import {
  display,
  editorKeyFromKeyboard,
  evaluate,
  type FormulaKey,
  type FormulaState,
  formulaAmountCents,
  formulaFromValue,
  initialFormula,
  MAX_FORMULA_LENGTH,
  pressKey,
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
