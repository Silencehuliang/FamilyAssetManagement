import { describe, expect, it } from 'vitest'
import { errorText } from './errors'

describe('errorText(错误文案)', () => {
  it('Error 子类统一取 message(DomainError / ApiError 同行为)', () => {
    expect(errorText(new Error('余额不足'))).toBe('余额不足')
    class DomainLike extends Error {}
    class ApiLike extends Error {}
    expect(errorText(new DomainLike('分类不存在'))).toBe('分类不存在')
    expect(errorText(new ApiLike('网络错误'))).toBe('网络错误')
  })

  it('非 Error 回退默认文案', () => {
    expect(errorText('boom')).toBe('操作失败,请重试')
    expect(errorText(null)).toBe('操作失败,请重试')
    expect(errorText({ message: 'obj' })).toBe('操作失败,请重试')
  })

  it('可自定义兜底文案(同步失败场景)', () => {
    expect(errorText(undefined, '同步失败')).toBe('同步失败')
    expect(errorText(new TypeError('Failed to fetch'), '同步失败')).toBe('Failed to fetch')
  })
})
