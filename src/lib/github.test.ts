import { describe, expect, it } from 'vitest'
import { createLedgerStore, getFile, putFile } from './github'

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

interface RecordedRequest {
  method: string
  url: URL
  headers: Headers
  body?: unknown
}

/** 模拟 GitHub Contents API */
function githubStub(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const requests: RecordedRequest[] = []
  let counter = 0

  const impl = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    let body: unknown
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body)
    }
    requests.push({ method, url, headers, body })

    if (method === 'PUT') {
      const payload = body as { content: string; sha?: string }
      files.set(url.pathname, encodeBase64Utf8(decodeBase64Utf8(payload.content)))
      const sha = `new-sha-${++counter}`
      return Promise.resolve(Response.json({ content: { sha } }, { status: 201 }))
    }
    const content = files.get(url.pathname)
    if (content === undefined) {
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    return Promise.resolve(
      Response.json({
        content: `${encodeBase64Utf8(content)}\n`,
        encoding: 'base64',
        sha: `sha-${url.pathname}`,
      }),
    )
  }
  return { impl, requests, files }
}

const REPO = 'family/ledger'
const TOKEN = 'token-abc'

describe('getFile', () => {
  it('请求 Contents API 并解码 base64 内容', async () => {
    const stub = githubStub({
      '/repos/family/ledger/contents/ledger/months/2026-10.json': '{"expenses":[]}',
    })
    const file = await getFile(REPO, TOKEN, 'ledger/months/2026-10.json', stub.impl)
    expect(file).toEqual({
      content: '{"expenses":[]}',
      sha: 'sha-/repos/family/ledger/contents/ledger/months/2026-10.json',
    })
    const request = stub.requests[0]
    expect(request?.method).toBe('GET')
    expect(request?.url.href).toBe(
      'https://api.github.com/repos/family/ledger/contents/ledger/months/2026-10.json',
    )
    expect(request?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(request?.headers.get('Accept')).toBe('application/vnd.github+json')
    expect(request?.headers.get('User-Agent')).toBe('family-ledger')
  })

  it('404 返回 null', async () => {
    const stub = githubStub()
    await expect(getFile(REPO, TOKEN, 'ledger/meta/members.json', stub.impl)).resolves.toBeNull()
  })

  it('其他错误转为 502 github_error', async () => {
    const failing = (): Promise<Response> =>
      Promise.resolve(new Response('rate limited', { status: 403 }))
    await expect(getFile(REPO, TOKEN, 'ledger/x.json', failing)).rejects.toMatchObject({
      status: 502,
      code: 'github_error',
    })
  })

  it('路径中的特殊字符按段编码', async () => {
    const stub = githubStub()
    await getFile(REPO, TOKEN, 'ledger/月 目录/a.json', stub.impl)
    expect(stub.requests[0]?.url.href).toBe(
      `https://api.github.com/repos/${REPO}/contents/ledger/${encodeURIComponent('月 目录')}/a.json`,
    )
  })
})

describe('putFile', () => {
  it('提交 base64 内容并返回新 sha', async () => {
    const stub = githubStub()
    const sha = await putFile(
      REPO,
      TOKEN,
      'ledger/months/2026-10.json',
      '{"expenses":[{"note":"午餐"}]}',
      undefined,
      stub.impl,
    )
    expect(sha).toBe('new-sha-1')
    const request = stub.requests[0]
    expect(request?.method).toBe('PUT')
    const body = request?.body as { message: string; content: string }
    expect(body.message).toBe('chore(ledger): ledger/months/2026-10.json')
    expect(decodeBase64Utf8(body.content)).toBe('{"expenses":[{"note":"午餐"}]}')
  })

  it('更新已有文件时携带 sha', async () => {
    const stub = githubStub()
    await putFile(REPO, TOKEN, 'ledger/meta/members.json', '{}', 'existing-sha', stub.impl)
    expect(stub.requests[0]?.body).toMatchObject({ sha: 'existing-sha' })
  })
})

describe('createLedgerStore', () => {
  it('组装 getFile/putFile 并复用注入的 fetch', async () => {
    const stub = githubStub({ '/repos/family/ledger/contents/ledger/a.json': 'A' })
    const store = createLedgerStore({ repo: REPO, token: TOKEN, fetchImpl: stub.impl })
    await expect(store.getFile('ledger/a.json')).resolves.toMatchObject({ content: 'A' })
    const sha = await store.putFile('ledger/a.json', 'B')
    expect(sha).toBe('new-sha-1')
    expect(stub.files.get('/repos/family/ledger/contents/ledger/a.json')).toBe(
      encodeBase64Utf8('B'),
    )
  })
})
