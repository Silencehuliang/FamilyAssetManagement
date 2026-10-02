import { buildHealthPayload } from '../../src/lib/health'

export const onRequestGet = (): Response => {
  return Response.json(buildHealthPayload('0.1.0'))
}
