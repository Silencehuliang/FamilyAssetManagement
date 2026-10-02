/**
 * 会话持久化:JWT 与当前成员存 localStorage(键 fl.session),
 * 不进 IndexedDB —— 本地账本缓存可被清除,会话凭据单独存放便于登出即焚。
 * localStorage 不可用(隐私模式等)时退化为内存存储,登录仍可用、刷新后需重新登录。
 */
import type { Member } from '../domain'

export const SESSION_STORAGE_KEY = 'fl.session'

export interface StoredSession {
  token: string
  member: Member
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

const memoryStorage = createMemoryStorage()

export function defaultSessionStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem(SESSION_STORAGE_KEY)
      return localStorage
    }
  } catch {
    // 隐私模式等场景下访问 localStorage 抛异常:退化为内存存储
  }
  return memoryStorage
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Record<string, unknown>
  if (typeof session.token !== 'string' || session.token === '') return false
  const member = session.member
  return (
    typeof member === 'object' &&
    member !== null &&
    typeof (member as Member).id === 'string' &&
    typeof (member as Member).username === 'string' &&
    typeof (member as Member).displayName === 'string' &&
    ((member as Member).role === 'admin' || (member as Member).role === 'member')
  )
}

/** 读取已存会话;内容损坏或缺失返回 null(并顺手清理脏数据) */
export function loadStoredSession(
  storage: StorageLike = defaultSessionStorage(),
): StoredSession | null {
  let raw: string | null
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isStoredSession(parsed)) return parsed
  } catch {
    // fallthrough: 清理损坏数据
  }
  storage.removeItem(SESSION_STORAGE_KEY)
  return null
}

export function saveStoredSession(
  session: StoredSession,
  storage: StorageLike = defaultSessionStorage(),
): void {
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredSession(storage: StorageLike = defaultSessionStorage()): void {
  storage.removeItem(SESSION_STORAGE_KEY)
}
