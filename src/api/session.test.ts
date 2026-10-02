import { describe, expect, it } from 'vitest'
import type { Member } from '../domain'
import {
  clearStoredSession,
  loadStoredSession,
  SESSION_STORAGE_KEY,
  type StorageLike,
  saveStoredSession,
} from './session'

const ADA: Member = {
  id: 'm-ada',
  username: 'ada',
  displayName: '阿达',
  role: 'admin',
  disabled: false,
  createdAt: '2026-09-01T00:00:00.000Z',
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

describe('会话存储', () => {
  it('写入后可读回;清除后为 null', () => {
    const storage = memoryStorage()
    saveStoredSession({ token: 'jwt-1', member: ADA }, storage)

    expect(loadStoredSession(storage)).toEqual({ token: 'jwt-1', member: ADA })

    clearStoredSession(storage)
    expect(loadStoredSession(storage)).toBeNull()
    expect(storage.data.size).toBe(0)
  })

  it('损坏的 JSON 与形状不符的数据视为未登录并清理', () => {
    const storage = memoryStorage()
    storage.setItem(SESSION_STORAGE_KEY, '{not json')
    expect(loadStoredSession(storage)).toBeNull()
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false)

    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: '', member: ADA }))
    expect(loadStoredSession(storage)).toBeNull()
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false)

    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 't', member: { id: 1 } }))
    expect(loadStoredSession(storage)).toBeNull()
  })
})
