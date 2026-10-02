import { describe, expect, it } from 'vitest'
import type { JwtPayload } from './auth/jwt'
import type { LedgerStore, RepoFile } from './github'
import { HttpError } from './http'
import { readLedgerFile, validateLedgerPath, writeLedgerFile } from './ledger-files'

class MemoryStore implements LedgerStore {
  readonly files = new Map<string, RepoFile>()
  readonly writes: { path: string; content: string; sha?: string }[] = []

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, { content, sha: `sha:${path}` })
    }
  }

  getFile(path: string): Promise<RepoFile | null> {
    const file = this.files.get(path)
    return Promise.resolve(file ? { ...file } : null)
  }

  putFile(path: string, content: string, sha?: string): Promise<string> {
    this.writes.push({ path, content, sha })
    const newSha = `sha:${path}#${this.writes.length}`
    this.files.set(path, { content, sha: newSha })
    return Promise.resolve(newSha)
  }
}

function session(role: 'admin' | 'member'): JwtPayload {
  return { sub: 'member-1', role, name: '测试', iat: 0, exp: 1_000_000_000 }
}

describe('validateLedgerPath(路径门禁)', () => {
  it('放行 ledger/ 下的合法路径', () => {
    expect(validateLedgerPath('ledger/months/2026-10.json')).toBe('ledger/months/2026-10.json')
    expect(validateLedgerPath('ledger/meta/members.json')).toBe('ledger/meta/members.json')
  })

  it.each([
    ['meta/members.json'],
    [''],
    ['ledgerX/months/2026-10.json'],
    ['ledger/../secret.txt'],
    ['ledger/months/../../etc.json'],
    ['ledger/months\\2026-10.json'],
    ['ledger/months//2026-10.json'],
    [42],
    [null],
    [undefined],
  ])('拒绝越界或非法路径 %s', (path) => {
    expect(() => validateLedgerPath(path)).toThrow(HttpError)
    expect(() => validateLedgerPath(path)).toThrow(/ledger\//)
  })
})

describe('readLedgerFile(代理读取)', () => {
  it('返回文件内容与 sha', async () => {
    const store = new MemoryStore({ 'ledger/months/2026-10.json': '{"expenses":[]}' })
    await expect(readLedgerFile(store, 'ledger/months/2026-10.json')).resolves.toEqual({
      content: '{"expenses":[]}',
      sha: 'sha:ledger/months/2026-10.json',
    })
  })

  it('文件不存在返回 404', async () => {
    const store = new MemoryStore()
    await expect(readLedgerFile(store, 'ledger/months/2026-10.json')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('路径非法返回 400', async () => {
    const store = new MemoryStore()
    await expect(readLedgerFile(store, 'meta/members.json')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_path',
    })
  })
})

describe('writeLedgerFile(代理写入)', () => {
  it('任何成员都可写月文件,返回新 sha', async () => {
    const store = new MemoryStore()
    const result = await writeLedgerFile(store, session('member'), {
      path: 'ledger/months/2026-10.json',
      content: '{"expenses":[]}',
    })
    expect(result.sha).toBeTypeOf('string')
    expect(store.writes[0]).toMatchObject({
      path: 'ledger/months/2026-10.json',
      content: '{"expenses":[]}',
    })
  })

  it('普通成员写 members.json 被拒绝(403)', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/meta/members.json',
        content: '{"members":[]}',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(store.writes).toHaveLength(0)
  })

  it('管理员可写 members.json', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('admin'), {
        path: 'ledger/meta/members.json',
        content: '{"members":[]}',
        sha: 'sha:known',
      }),
    ).resolves.toMatchObject({ sha: expect.stringContaining('members.json') })
    expect(store.writes[0]).toMatchObject({ path: 'ledger/meta/members.json', sha: 'sha:known' })
  })

  it('路径非法返回 400 且不写入', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('admin'), { path: 'README.md', content: 'hi' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_path' })
    expect(store.writes).toHaveLength(0)
  })
})

describe('元数据写入的角色矩阵与内容校验', () => {
  it('分类/预算元数据仅管理员可写,月度支出文件所有成员可写', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/meta/categories.json',
        content: '{"categories":[]}',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/meta/budgets.json',
        content: '{"budgets":{}}',
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/months/2026-10.json',
        content: '{"expenses":[]}',
      }),
    ).resolves.toMatchObject({ sha: expect.any(String) })
  })

  it('members.json 内容不合法时拒绝写入(400),合法时放行', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('admin'), {
        path: 'ledger/meta/members.json',
        content: 'not json at all',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_members' })
    expect(store.writes).toHaveLength(0)
    await expect(
      writeLedgerFile(store, session('admin'), {
        path: 'ledger/meta/members.json',
        content: '{"members":[]}',
      }),
    ).resolves.toMatchObject({ sha: expect.any(String) })
  })
})
