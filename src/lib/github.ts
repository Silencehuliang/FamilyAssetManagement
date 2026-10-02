/**
 * GitHub Contents API 薄封装(ADR-0002):账本仓库的读写代理。
 * 客户端永不接触 GITHUB_TOKEN —— 只在服务端使用。
 * fetch 可注入,便于契约测试 mock GitHub API。
 */

import { base64ToBytes, bytesToBase64 } from './base64'
import { HttpError } from './http'

const API_ROOT = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

export interface RepoFile {
  content: string
  sha: string
}

/** 仓库目录项(目录列表接口;type 为 'file' | 'dir' 等) */
export interface RepoDirEntry {
  name: string
  path: string
  sha: string
  type: string
}

/** 仓库文件存取接口;服务层依赖它而非直接依赖 GitHub */
export interface LedgerStore {
  getFile(path: string): Promise<RepoFile | null>
  putFile(path: string, content: string, sha?: string): Promise<string>
  listDirectory(path: string): Promise<RepoDirEntry[]>
  deleteFile(path: string, sha: string): Promise<void>
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
  return { content: new TextDecoder().decode(base64ToBytes(data.content)), sha: data.sha }
}

/** PUT /repos/{repo}/contents/{path};返回新 blob sha */ export async function putFile(
  repo: string,
  token: string,
  path: string,
  content: string,
  sha?: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string> {
  const body: Record<string, unknown> = {
    message: `chore(ledger): ${path}`,
    content: bytesToBase64(new TextEncoder().encode(content)),
  }
  if (sha !== undefined) {
    body.sha = sha
  }
  const response = await fetchImpl(contentsUrl(repo, path), {
    method: 'PUT',
    headers: requestHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  // 422 = 无 sha 时文件已存在(首次创建竞态),或 sha 过期(乐观并发冲突)
  if (response.status === 422) {
    throw new HttpError(409, 'file_conflict', '远端文件状态已变化,请刷新后重试')
  }
  await assertOk(response, false)
  const data = (await response.json()) as { content?: { sha?: string } }
  const newSha = data.content?.sha
  if (typeof newSha !== 'string') {
    throw new HttpError(502, 'github_error', 'GitHub 响应缺少新 sha')
  }
  return newSha
}

interface DirEntryResponse {
  name?: unknown
  path?: unknown
  sha?: unknown
  type?: unknown
}

/**
 * GET /repos/{repo}/contents/{path} 的目录形态;目录不存在返回空数组。
 * 响应是数组而非对象时即为目录列表。
 */
export async function listDirectory(
  repo: string,
  token: string,
  path: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<RepoDirEntry[]> {
  const response = await fetchImpl(contentsUrl(repo, path), { headers: requestHeaders(token) })
  await assertOk(response, true)
  if (response.status === 404) {
    return []
  }
  const data = (await response.json()) as unknown
  if (!Array.isArray(data)) {
    throw new HttpError(502, 'github_error', 'GitHub Contents 响应不是目录列表')
  }
  const entries: RepoDirEntry[] = []
  for (const item of data as DirEntryResponse[]) {
    if (
      typeof item.name === 'string' &&
      typeof item.path === 'string' &&
      typeof item.sha === 'string' &&
      typeof item.type === 'string'
    ) {
      entries.push({ name: item.name, path: item.path, sha: item.sha, type: item.type })
    }
  }
  return entries
}

/** DELETE /repos/{repo}/contents/{path};sha 为删除目标的当前 blob sha(乐观并发) */
export async function deleteFile(
  repo: string,
  token: string,
  path: string,
  sha: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<void> {
  const response = await fetchImpl(contentsUrl(repo, path), {
    method: 'DELETE',
    headers: requestHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message: `chore(ledger): delete ${path}`, sha }),
  })
  // 422 = sha 过期或文件已不存在(乐观并发冲突)
  if (response.status === 422) {
    throw new HttpError(409, 'file_conflict', '远端文件状态已变化,请刷新后重试')
  }
  await assertOk(response, false)
}

/** 组装仓库客户端;供 Pages Function 与服务层使用 */
export function createLedgerStore(options: GithubClientOptions): LedgerStore {
  const { repo, token, fetchImpl = defaultFetch } = options
  return {
    getFile: (path) => getFile(repo, token, path, fetchImpl),
    putFile: (path, content, sha) => putFile(repo, token, path, content, sha, fetchImpl),
    listDirectory: (path) => listDirectory(repo, token, path, fetchImpl),
    deleteFile: (path, sha) => deleteFile(repo, token, path, sha, fetchImpl),
  }
}
