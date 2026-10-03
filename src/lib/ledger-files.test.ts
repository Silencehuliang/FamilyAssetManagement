import { describe, expect, it } from 'vitest'
import type { JwtPayload } from './auth/jwt'
import type { LedgerStore, RepoDirEntry, RepoFile } from './github'
import { HttpError } from './http'
import {
  deleteLedgerFile,
  listLedgerFiles,
  readLedgerFile,
  validateLedgerPath,
  writeLedgerFile,
} from './ledger-files'

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

  listDirectory(path: string): Promise<RepoDirEntry[]> {
    const prefix = `${path}/`
    return Promise.resolve(
      [...this.files.entries()]
        .filter(([filePath]) => filePath.startsWith(prefix))
        .map(([filePath, file]) => ({
          name: filePath.slice(prefix.length),
          path: filePath,
          sha: file.sha,
          type: 'file',
        })),
    )
  }

  deleteFile(path: string): Promise<void> {
    this.files.delete(path)
    return Promise.resolve()
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

  it('members.json 双向皆被代理拒绝(服务端专属管理,403)', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/meta/members.json',
        content: '{"members":[]}',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'members_server_owned' })
    await expect(
      writeLedgerFile(store, session('admin'), {
        path: 'ledger/meta/members.json',
        content: '{"members":[]}',
        sha: 'sha:known',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'members_server_owned' })
    expect(store.writes).toHaveLength(0)
    await expect(readLedgerFile(store, 'ledger/meta/members.json')).rejects.toMatchObject({
      status: 403,
      code: 'members_not_readable',
    })
  })

  it('路径非法返回 400 且不写入', async () => {
    const store = new MemoryStore()
    await expect(
      writeLedgerFile(store, session('admin'), { path: 'README.md', content: 'hi' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_path' })
    expect(store.writes).toHaveLength(0)
  })
})

describe('元数据写入的角色矩阵', () => {
  it('分类/预算/标签组仅管理员可写;标签实体与月度支出文件所有成员可写', async () => {
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
        path: 'ledger/meta/tagGroups.json',
        content: '{"groups":[]}',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/meta/tags.json',
        content: '{"tags":[]}',
      }),
    ).resolves.toMatchObject({ sha: expect.any(String) })
    await expect(
      writeLedgerFile(store, session('member'), {
        path: 'ledger/months/2026-10.json',
        content: '{"expenses":[]}',
      }),
    ).resolves.toMatchObject({ sha: expect.any(String) })
  })
})

describe('listLedgerFiles(同步清单)', () => {
  it('列出月份文件与五个 meta 文件,members.json 永不包含', async () => {
    const store = new MemoryStore({
      'ledger/months/2026-10.json': '{"expenses":[]}',
      'ledger/months/2026-09.json': '{"expenses":[{"id":"e-1"}]}',
      'ledger/meta/categories.json': '{"categories":[]}',
      'ledger/meta/tags.json': '{"tags":[]}',
      'ledger/meta/tagGroups.json': '{"groups":[]}',
      'ledger/meta/budgets.json': '{"budgets":{}}',
      'ledger/meta/recurring.json': '{"recurring":[]}',
      'ledger/meta/members.json': '{"members":[]}',
      'README.md': 'not ledger',
    })

    const files = await listLedgerFiles(store)

    expect(Object.keys(files).sort()).toEqual([
      'ledger/meta/budgets.json',
      'ledger/meta/categories.json',
      'ledger/meta/recurring.json',
      'ledger/meta/tagGroups.json',
      'ledger/meta/tags.json',
      'ledger/months/2026-09.json',
      'ledger/months/2026-10.json',
    ])
    expect(files['ledger/months/2026-10.json']).toEqual({
      content: '{"expenses":[]}',
      revision: 'sha:ledger/months/2026-10.json',
    })
  })

  it('缺失的 meta 文件省略,months 目录不存在时只有 meta 文件', async () => {
    const store = new MemoryStore({ 'ledger/meta/categories.json': '{"categories":[]}' })
    const files = await listLedgerFiles(store)
    expect(Object.keys(files)).toEqual(['ledger/meta/categories.json'])
  })
})

describe('deleteLedgerFile(删除月份文件)', () => {
  it('删除月份文件成功', async () => {
    const store = new MemoryStore({ 'ledger/months/2026-10.json': '{"expenses":[]}' })
    await expect(
      deleteLedgerFile(store, { path: 'ledger/months/2026-10.json', sha: 'sha:known' }),
    ).resolves.toEqual({ deleted: true })
    expect(store.files.has('ledger/months/2026-10.json')).toBe(false)
  })

  it('meta 文件与非法路径拒绝删除(403/400)', async () => {
    const store = new MemoryStore({ 'ledger/meta/categories.json': '{"categories":[]}' })
    await expect(
      deleteLedgerFile(store, { path: 'ledger/meta/categories.json', sha: 'sha:known' }),
    ).rejects.toMatchObject({ status: 403, code: 'not_deletable' })
    await expect(
      deleteLedgerFile(store, { path: 'ledger/meta/members.json', sha: 'sha:known' }),
    ).rejects.toMatchObject({ status: 403, code: 'not_deletable' })
    await expect(deleteLedgerFile(store, { path: 'README.md', sha: 's' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_path',
    })
    expect(store.files.size).toBe(1)
  })
})
