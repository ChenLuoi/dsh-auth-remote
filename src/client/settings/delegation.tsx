import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useEffect, useId, useState, type ComponentType } from 'react'
import {
  DEFAULT_DELEGATED_SESSION_DAYS,
  DELEGATED_SESSION_DAYS,
  DELEGATION_CAPABILITY,
  DELEGATION_PATH,
  isDelegatedSessionDays,
  type DelegatedSessionDays,
} from '../../shared/delegation.js'
import { authRequest, SettingsFailure } from './api.js'
import {
  CancelButton,
  OperationError,
  SecurityDialog,
  useSecurityOperation,
  type SecurityTranslate,
} from './dialog.js'

const content = 'settings.remoteConnection.content'
const createEndpoint = 'remoteConnection/create'
const decideEndpoint = 'remoteConnection/decidePairing'

interface NativeProps {
  create(): void
  decide(id: string, decision: 'allow' | 'deny'): Promise<void>
}

interface NativeEntry {
  component: ComponentType<NativeProps>
  locale?: string
  options: { priority?: number }
}
interface NativeSlots {
  entries(name: string): readonly NativeEntry[]
  subscribe(name: string, callback: () => void): () => void
  inject(name: string, callback: () => () => void): void
  register(
    options: { name: string; locale?: string; priority: number },
    component: ComponentType<NativeProps>,
  ): () => void
}

interface Access {
  canAuthorize: boolean
  totpEnabled: boolean
}

interface Gesture {
  pairingId: string | null
  present(): void
}

interface Result {
  result: unknown
}

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function AuthorizeDevice({
  gesture,
  access,
  t,
  close,
  succeed,
}: {
  gesture: Gesture
  access: Access
  t: SecurityTranslate
  close: () => void
  succeed: (value: unknown) => boolean
}): JSX.Element {
  const [requestId] = useState(newRequestId)
  const [days, setDays] = useState<DelegatedSessionDays>(DEFAULT_DELEGATED_SESSION_DAYS)
  const [uncertain, setUncertain] = useState(false)
  const durationId = useId()
  const { busy, message, run } = useSecurityOperation()
  const title = t(gesture.pairingId === null ? 'delegationCreate' : 'delegationApprove')
  return (
    <SecurityDialog title={title} t={t} close={close} busy={busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const code = new FormData(event.currentTarget).get('code')
          void run(
            async () => {
              try {
                return await authRequest<Result>(DELEGATION_PATH, {
                  requestId,
                  pairingId: gesture.pairingId,
                  days,
                  ...(typeof code === 'string' ? { code: code.trim() } : {}),
                })
              } catch (error) {
                if (!(error instanceof SettingsFailure) || error.status === 503) setUncertain(true)
                throw error
              }
            },
            ({ result }) => {
              if (!succeed(result)) {
                setUncertain(true)
                throw new SettingsFailure(503, 'service_unavailable')
              }
            },
          )
        }}
      >
        <fieldset disabled={busy}>
          <label className="auth-remote-field">
            <span id={durationId}>{t('delegationDuration')}</span>
            <select
              value={days}
              disabled={uncertain}
              data-autofocus
              aria-labelledby={durationId}
              onChange={(event) => {
                const next = Number(event.currentTarget.value)
                if (isDelegatedSessionDays(next)) setDays(next)
              }}
            >
              {DELEGATED_SESSION_DAYS.map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? t('delegationOneDay') : t('delegationDays', { days: value })}
                </option>
              ))}
            </select>
          </label>
          {access.totpEnabled && (
            <label className="auth-remote-field">
              {t('settingsCurrentCode')}
              <input name="code" autoComplete="one-time-code" required />
            </label>
          )}
        </fieldset>
        <OperationError message={message} t={t} />
        <div className="auth-remote-dialog-actions">
          <CancelButton t={t} close={close} busy={busy} />
          <button className="auth-remote-button auth-remote-primary" type="submit" disabled={busy}>
            {title}
          </button>
        </div>
      </form>
    </SecurityDialog>
  )
}

function matches(endpoint: string, payload: unknown, id: string | null): boolean {
  if (id === null) return endpoint === createEndpoint
  if (endpoint !== decideEndpoint || typeof payload !== 'object' || !payload) return false
  const args: unknown = Reflect.get(payload, 'args')
  return (
    typeof args === 'object' &&
    args !== null &&
    Reflect.get(args, 'id') === id &&
    Reflect.get(args, 'decision') === 'allow'
  )
}

/** Let the original controllers display results already authorized by the plugin. */
export function installNativeDelegation(ctx: Context): void {
  if (Reflect.get(globalThis, DELEGATION_CAPABILITY) !== true) return
  const slots = ctx.get('slots') as NativeSlots
  const connection = ctx.get('connection') as ConnectionHandle
  const rpc = connection.rpc
  const t = ctx.locale.bind('auth-remote')
  let prepared: { id: string | null; value: unknown } | undefined
  ctx.effect(() => {
    const original = rpc.call
    const deliver: typeof original = async (channel, endpoint, payload, signal) => {
      const result = prepared
      if (result && channel === '/api' && matches(endpoint, payload, result.id)) {
        signal?.throwIfAborted()
        prepared = undefined
        return { ok: true, value: result.value }
      }
      return original.call(rpc, channel, endpoint, payload, signal)
    }
    rpc.call = deliver
    return () => {
      prepared = undefined
      if (rpc.call === deliver) rpc.call = original
    }
  }, 'auth-remote: native delegation presentation')

  slots.inject(content, () => {
    let registered: NativeEntry | undefined
    let remove: (() => void) | undefined
    const wrappers = new WeakSet<object>()
    const update = () => {
      const native = slots
        .entries(content)
        .find((entry) => entry.locale === 'remoteConnection' && !wrappers.has(entry.component))
      if (native === registered) return
      registered = native
      remove?.()
      remove = undefined
      if (!native) return
      const Native = native.component
      function RemotePanel(props: NativeProps): JSX.Element | null {
        const [access, setAccess] = useState<Access>()
        const [failed, setFailed] = useState(false)
        const [gesture, setGesture] = useState<Gesture>()
        useEffect(() => {
          let active = true
          void authRequest<Access>(DELEGATION_PATH).then(
            (value) => {
              if (active) setAccess(value)
            },
            () => {
              if (active) setFailed(true)
            },
          )
          return () => {
            active = false
          }
        }, [])
        if (failed) return <p role="alert">{t('errorServiceUnavailable')}</p>
        if (!access) return null
        if (!access.canAuthorize) return <p>{t('delegationReadOnly')}</p>
        return (
          <>
            <Native
              {...props}
              create={() => setGesture({ pairingId: null, present: props.create })}
              decide={async (id, decision) => {
                if (decision === 'deny') return props.decide(id, decision)
                setGesture({
                  pairingId: id,
                  present: () => {
                    void props.decide(id, decision)
                  },
                })
              }}
            />
            {gesture && (
              <AuthorizeDevice
                access={access}
                gesture={gesture}
                t={t}
                close={() => setGesture(undefined)}
                succeed={(value) => {
                  prepared = { id: gesture.pairingId, value }
                  try {
                    gesture.present()
                    if (prepared) return false
                    setGesture(undefined)
                    return true
                  } finally {
                    prepared = undefined
                  }
                }}
              />
            )}
          </>
        )
      }
      wrappers.add(RemotePanel)
      remove = slots.register(
        { name: content, locale: 'remoteConnection', priority: (native.options.priority ?? 0) - 1 },
        RemotePanel,
      )
    }
    const stop = slots.subscribe(content, update)
    try {
      update()
    } catch (error) {
      stop()
      remove?.()
      throw error
    }
    return () => {
      stop()
      remove?.()
    }
  })
}
