import type { IncomingMessage } from 'node:http'
import type { RequestOriginContext } from './origin-policy.js'

const contexts = new WeakMap<IncomingMessage, RequestOriginContext>()

export function setRequestContext(req: IncomingMessage, context: RequestOriginContext): void {
  if (contexts.has(req)) throw new Error('auth-remote: request context already set')
  contexts.set(req, context)
}

export function requireRequestContext(req: IncomingMessage): RequestOriginContext {
  const context = contexts.get(req)
  if (!context) throw new Error('auth-remote: missing validated request context')
  return context
}
