import { describe, expect, it } from 'vitest'
import { SyncConflictError } from './endpoint'
import { InMemoryEndpoint } from './in-memory'

describe('InMemoryEndpoint', () => {
  it('构造初始文件可列出,putFile 创建与更新都推进修订号', async () => {
    const endpoint = new InMemoryEndpoint({ 'ledger/meta/members.json': '{}\n' })

    const initial = await endpoint.listFiles()
    expect(initial['ledger/meta/members.json']?.content).toBe('{}\n')
    expect(initial['ledger/meta/members.json']?.revision).toBe('rev-1')

    const created = await endpoint.putFile('ledger/months/2026-10.json', '[]\n')
    const updated = await endpoint.putFile('ledger/meta/members.json', '{\n}\n')
    expect(updated.revision).not.toBe(initial['ledger/meta/members.json']?.revision)
    expect(created.revision).not.toBe(updated.revision)

    const after = await endpoint.listFiles()
    expect(Object.keys(after).sort()).toEqual([
      'ledger/meta/members.json',
      'ledger/months/2026-10.json',
    ])
    expect(after['ledger/months/2026-10.json']?.content).toBe('[]\n')
  })

  it('baseRevision 不匹配抛 SyncConflictError,匹配则写入成功', async () => {
    const endpoint = new InMemoryEndpoint()
    await endpoint.putFile('a.json', 'v1')

    await expect(endpoint.putFile('a.json', 'v2', 'rev-999')).rejects.toThrowError(
      SyncConflictError,
    )
    // 失败的写入不得改动内容
    expect((await endpoint.listFiles())['a.json']?.content).toBe('v1')

    const current = (await endpoint.listFiles())['a.json']?.revision
    await endpoint.putFile('a.json', 'v2', current)
    expect((await endpoint.listFiles())['a.json']?.content).toBe('v2')

    await expect(endpoint.deleteFile('a.json', 'rev-999')).rejects.toThrowError(SyncConflictError)
  })

  it('deleteFile 删除文件;assignFile 绕过校验直接覆盖', async () => {
    const endpoint = new InMemoryEndpoint({ 'a.json': 'v1' })
    await endpoint.deleteFile('a.json')
    expect(await endpoint.listFiles()).toEqual({})

    endpoint.assignFile('b.json', 'v1')
    endpoint.assignFile('b.json', 'v2')
    const files = await endpoint.listFiles()
    expect(files['b.json']?.content).toBe('v2')
  })
})
