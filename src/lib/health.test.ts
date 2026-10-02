import { describe, expect, it } from 'vitest'
import { buildHealthPayload } from './health'

describe('buildHealthPayload', () => {
  it('reports ok status with app identity', () => {
    const payload = buildHealthPayload('0.1.0', new Date('2026-10-02T08:00:00Z'))
    expect(payload.status).toBe('ok')
    expect(payload.app).toBe('family-ledger')
    expect(payload.version).toBe('0.1.0')
    expect(payload.time).toBe('2026-10-02T08:00:00.000Z')
  })
})
