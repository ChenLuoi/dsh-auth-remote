import { symbols } from '@deepseek-ai/cordis'
import type {
  ConnectionTrustRequest,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import { sessionHash } from '../../auth/sessions.js'
import type { AuthService } from '../../auth/service.js'
import type { AuthConnections, SessionPeer } from '../../http/connections.js'
import { sessionTokenFromCookie } from '../../http/routes.js'
import { AUTH_COOKIE } from '../../shared/auth-contract.js'

interface ProviderRequest extends ConnectionTrustRequest {
  readonly signal?: AbortSignal | undefined
  readonly socket?: { readonly destroyed: boolean } | undefined
}

type Admission = { peer: SessionPeer } | { rejection: 401 | 403 | 503 }

interface NativeAuthentication {
  register(provider: {
    authenticate(request: ProviderRequest): SessionPeer | undefined
  }): () => Promise<void>
  authenticate(request: ProviderRequest): Admission
}

/** Exact alpha.2 provider registry and Cordis service view, checked before readiness. */
export function connectionAuthentication(connection: HostConnectionHandle): NativeAuthentication {
  const service: unknown = Reflect.get(connection, 'authentication')
  if (
    !service ||
    typeof service !== 'object' ||
    typeof Reflect.get(service, 'register') !== 'function' ||
    typeof Reflect.get(service, 'authenticate') !== 'function' ||
    typeof connection.createPeer !== 'function'
  ) {
    throw new Error('auth-remote: Connection lacks the alpha.2 authentication provider contract')
  }
  return service as NativeAuthentication
}

/** Use the public registry while excluding the Remote service's earlier shared Peer. */
export function installConnectionProvider(
  connection: HostConnectionHandle,
  auth: AuthService,
  connections: AuthConnections,
): () => void {
  const service = connectionAuthentication(connection)
  const original: unknown = Reflect.get(service, symbols.original)
  if (!original || typeof original !== 'object' || Object.hasOwn(original, 'authenticate')) {
    throw new Error('auth-remote: cannot isolate native authentication providers')
  }
  const authenticate = Reflect.get(original, 'authenticate') as NativeAuthentication['authenticate']
  if (
    typeof authenticate !== 'function' ||
    authenticate.length !== 1 ||
    !Object.isExtensible(original)
  ) {
    throw new Error('auth-remote: incompatible alpha.2 provider dispatch')
  }
  const tokenFor = ({ headers }: ProviderRequest) =>
    sessionTokenFromCookie(headers instanceof Headers ? headers.get('cookie') : headers.cookie)
  const remove = service.register({
    authenticate(request) {
      const token = tokenFor(request)
      const session = token ? auth.session(token) : null
      if (!token || !session) return undefined
      return connections.peer(sessionHash(token), session, () =>
        connection.createPeer({ principal: { kind: 'owner' } }),
      )
    },
  })
  Object.defineProperty(original, 'authenticate', {
    configurable: true,
    value(this: NativeAuthentication, request: ProviderRequest): Admission {
      const token = tokenFor(request)
      if (!token) return { rejection: 401 }
      const cookie = `${AUTH_COOKIE}=${token}`
      const headers =
        request.headers instanceof Headers
          ? new Headers(request.headers)
          : { ...request.headers, cookie }
      if (headers instanceof Headers) headers.set('cookie', cookie)
      const admission = authenticate.call(this, { ...request, headers })
      if ('rejection' in admission) return admission
      return connections.ownsPeer(admission.peer) ? admission : { rejection: 401 }
    },
  })
  return () => {
    Reflect.deleteProperty(original, 'authenticate')
    // Registration also belongs to the Connection dependency effect.
    void remove().catch(() => {})
  }
}
