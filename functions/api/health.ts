import { buildHealthPayload } from '../../src/lib/health'

interface Env {
  APP_VERSION?: string
}

export const onRequestGet = ({ env }: { env: Env }): Response => {
  return Response.json(buildHealthPayload(env.APP_VERSION ?? 'dev'))
}
