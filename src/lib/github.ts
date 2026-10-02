/**
 * GitHub Contents API 薄封装(ADR-0002):账本仓库的读写代理。
 * 客户端永不接触 GITHUB_TOKEN —— 只在服务端使用。
 * fetch 可注入,便于契约测试 mock GitHub API。
 */
import { HttpError } from './http'

const API_ROOT = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

export interface RepoFile {
  content: string
  sha: string
}

/** 仓库文件存取接口;服务层依赖它而非直接依赖 GitHub */
export interface LedgerStore {
  getFile(path: string): Promise<RepoFile | null>
  putFile(path: string, content: string, sha?: string): Promise<string>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GithubClientOptions {
  /** 形如 owner/repo */
  repo: string
  token: string
  fetchImpl?: FetchLike
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

function contentsUrl(repo: string, path: string): string {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${API_ROOT}/repos/${repo}/contents/${encoded}`
}

function requestHeaders(token: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION)
  headers.set('User-Agent', 'family-ledger')
  return headers
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64.replaceAll(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function assertOk(response: Response, ignoreNotFound: boolean): Promise<void> {
  if (response.ok || (ignoreNotFound && response.status === 404)) {
    return
  }
  throw new HttpError(502, 'github_error', `GitHub API 返回 ${response.status}`)
}

interface ContentsResponse {
  content?: string
  encoding?: string
  sha?: string
}

/** GET /repos/{repo}/contents/{path};文件不存在返回 null */
export async function getFile(
  repo: string,
  token: string,
  path: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<RepoFile | null> {
  const response = await fetchImpl(contentsUrl(repo, path), { headers: requestHeaders(token) })
  await assertOk(response, true)
  if (response.status === 404) {
    return null
  }
  const data = (await response.json()) as ContentsResponse
  if (
    data.encoding !== 'base64' ||
    typeof data.content !== 'string' ||
    typeof data.sha !== 'string'
  ) {
    throw new HttpError(502, 'github_error', '不支持的 GitHub Contents 响应')
  }
  return { content: base64ToUtf8(data.content), sha: data.sha }
}

/** PUT /repos/{repo}/contents/{path};返回新 blob sha */
export async function putFile(
  repo: string,
  token: string,
  path: string,
  content: string,
  sha?: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string> {
  const body: Record<string, unknown> = {
    message: `chore(ledger): ${path}`,
    content: utf8ToBase64(content),
  }
  if (sha !== undefined) {
    body.sha = sha
  }
  const response = await fetchImpl(contentsUrl(repo, path), {
    method: 'PUT',
    headers: requestHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  await assertOk(response, false)
  const data = (await response.json()) as { content?: { sha?: string } }
  const newSha = data.content?.sha
  if (typeof newSha !== 'string') {
    throw new HttpError(502, 'github_error', 'GitHub 响应缺少新 sha')
  }
  return newSha
}

/** 组装仓库客户端;供 Pages Function 与服务层使用 */
export function createLedgerStore(options: GithubClientOptions): LedgerStore {
  const { repo, token, fetchImpl = defaultFetch } = options
  return {
    getFile: (path) => getFile(repo, token, path, fetchImpl),
    putFile: (path, content, sha) => putFile(repo, token, path, content, sha, fetchImpl),
  }
}
