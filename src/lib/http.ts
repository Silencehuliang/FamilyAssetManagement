/**
 * HTTP 层共用工具:统一的 JSON 错误契约 {error: code, message}。
 * 领域/服务层抛 HttpError,Pages Function 捕获后转为响应。
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'HttpError'
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status })
  }
  console.error(err)
  return Response.json({ error: 'server_error', message: 'internal error' }, { status: 500 })
}

/** 包一层:执行成功返回 JSON,失败按 HttpError 契约返回错误 */
export async function handleApi(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run())
  } catch (err) {
    return errorResponse(err)
  }
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw new HttpError(400, 'invalid_request', '请求体必须是 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_request', '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_request', `${field} 不能为空`)
  }
  return value.trim()
}

/** 同 requireString,但保留原始内容(不 trim):用于文件内容等对末尾空白敏感的场景 */
export function requireRawString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_request', `${field} 不能为空`)
  }
  return value
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
