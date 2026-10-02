export interface HealthPayload {
  status: 'ok'
  app: string
  version: string
  time: string
}

export function buildHealthPayload(version: string, now = new Date()): HealthPayload {
  return {
    status: 'ok',
    app: 'family-ledger',
    version,
    time: now.toISOString(),
  }
}
