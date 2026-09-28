import type { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AuthState, SessionRecord } from '../storage/state.js'
import { AuthStateStore } from '../storage/store.js'
import { AuthService } from '../auth/service.js'

interface Tracked {
  hash: string
  expiresAt: number
  timer: NodeJS.Timeout | undefined
  close(): Promise<void>
}

/** Long responses and upgraded sockets close before revocation commits report success. */
export class AuthConnections {
  private readonly active = new Set<Tracked>()
  private readonly unsubscribe: () => void

  constructor(
    store: AuthStateStore,
    private readonly auth: AuthService,
  ) {
    this.unsubscribe = store.subscribe((_previous, current) => this.reconcile(current))
  }

  trackResponse(hash: string, session: SessionRecord, response: ServerResponse): void {
    const entry = this.makeEntry(
      hash,
      session.expiresAt,
      () =>
        new Promise<void>((resolve) => {
          if (response.destroyed || response.writableEnded) return resolve()
          response.once('close', () => resolve())
          response.destroy()
        }),
    )
    response.once('close', () => this.remove(entry))
    response.once('finish', () => this.remove(entry))
  }

  trackSocket(hash: string, session: SessionRecord, socket: Duplex): void {
    const entry = this.makeEntry(
      hash,
      session.expiresAt,
      () =>
        new Promise<void>((resolve) => {
          if (socket.destroyed) return resolve()
          socket.once('close', () => resolve())
          socket.destroy()
        }),
    )
    socket.once('close', () => this.remove(entry))
  }

  private makeEntry(hash: string, expiresAt: number, close: () => Promise<void>): Tracked {
    let closing: Promise<void> | undefined
    const entry: Tracked = {
      hash,
      expiresAt,
      timer: undefined,
      close: () => (closing ??= close()),
    }
    this.active.add(entry)
    this.schedule(entry)
    return entry
  }

  private schedule(entry: Tracked): void {
    if (entry.timer) clearTimeout(entry.timer)
    const remaining = entry.expiresAt - Date.now()
    entry.timer = setTimeout(
      () => {
        if (entry.expiresAt <= Date.now()) void entry.close()
        else this.schedule(entry)
      },
      Math.max(1, Math.min(remaining, 2_147_483_647)),
    )
    entry.timer.unref()
  }

  private remove(entry: Tracked): void {
    if (!this.active.delete(entry)) return
    if (entry.timer) clearTimeout(entry.timer)
  }

  async reconcile(state: AuthState): Promise<void> {
    const closing: Promise<void>[] = []
    for (const entry of this.active) {
      const session = state.sessions[entry.hash]
      const account = state.account
      if (
        !session ||
        !account ||
        session.accountId !== account.id ||
        session.securityVersion !== account.securityVersion ||
        session.expiresAt <= Date.now() ||
        (this.auth.policySnapshot().requireTotp && !account.totp)
      ) {
        closing.push(entry.close())
      } else if (entry.expiresAt !== session.expiresAt) {
        entry.expiresAt = session.expiresAt
        this.schedule(entry)
      }
    }
    await Promise.all(closing)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.active].map((entry) => entry.close()))
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    await this.closeAll()
  }
}
