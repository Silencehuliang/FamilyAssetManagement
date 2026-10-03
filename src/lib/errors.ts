/**
 * 错误展示文案:把 unknown 归一为可直接 toast 的字符串。
 * DomainError / ApiError 等业务错误都继承 Error,直接取 message;其余回退到调用方给的兜底文案。
 */
export function errorText(err: unknown, fallback = '操作失败,请重试'): string {
  if (err instanceof Error) return err.message
  return fallback
}
