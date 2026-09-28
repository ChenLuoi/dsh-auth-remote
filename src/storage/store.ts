import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPrivateStateFile, STATE_FILE, StateLock } from './lock.js'
import { emptyState, validateState, type AuthState } from './state.js'

export type CommitStage =
  | 'afterTempWrite'
  | 'afterFileSync'
  | 'beforeRename'
  | 'afterRename'
  | 'afterDirSync'
  | 'beforeSuccess'

export interface StoreOptions {
  /** A failed notification makes the store unavailable before a caller can report success. */
  onCommitted?: (previous: AuthState, current: AuthState) => void | Promise<void>
  onUnavailable?: (reason: Error) => void
  /** Fault injection for isolated tests only. */
  onStage?: (stage: CommitStage) => void | Promise<void>
}

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** One process owns the lock; every mutation serializes through this instance. */
export class AuthStateStore {
  readonly path: string
  private state: AuthState
  private queue: Promise<void> = Promise.resolve()
  private unavailableReason: Error | null = null
  private closed = false
  private readonly listeners = new Set<
    (previous: AuthState, current: AuthState) => void | Promise<void>
  >()

  private constructor(
    private readonly lock: StateLock,
    state: AuthState,
    private readonly options: StoreOptions,
  ) {
    this.path = join(lock.dir, STATE_FILE)
    this.state = state
  }

  static async open(profileDir: string, options: StoreOptions = {}): Promise<AuthStateStore> {
    const lock = await StateLock.acquire(profileDir)
    try {
      const path = join(lock.dir, STATE_FILE)
      let state = emptyState()
      try {
        await assertPrivateStateFile(path)
        const info = await lstat(path)
        if (info.size > 16 * 1024 * 1024)
          throw new Error('auth-remote: state file exceeds the supported size')
        state = validateState(JSON.parse(await readFile(path, 'utf8')))
      } catch (error) {
        if (!errno(error, 'ENOENT')) throw error
      }
      return new AuthStateStore(lock, state, options)
    } catch (error) {
      await lock.release()
      throw error
    }
  }

  healthy(): boolean {
    return !this.closed && this.unavailableReason === null
  }

  current(): AuthState {
    if (!this.healthy()) throw this.unavailableReason ?? new Error('auth-remote: store is closed')
    return structuredClone(this.state)
  }

  /** Notifications finish before transact reports success; a failed listener closes admission. */
  subscribe(
    listener: (previous: AuthState, current: AuthState) => void | Promise<void>,
  ): () => void {
    if (!this.healthy()) throw this.unavailableReason ?? new Error('auth-remote: store is closed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async transact<T>(mutate: (draft: AuthState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (!this.healthy()) throw this.unavailableReason ?? new Error('auth-remote: store is closed')
      const draft = structuredClone(this.state)
      const result = await mutate(draft)
      if (this.state.revision >= Number.MAX_SAFE_INTEGER)
        throw new Error('auth-remote: state revision exhausted')
      draft.revision = this.state.revision + 1
      const next = validateState(draft)
      await this.persist(next)
      return result
    }
    const operation = this.queue.then(run)
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async persist(next: AuthState): Promise<void> {
    const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`, 'utf8')
    if (bytes.length > 16 * 1024 * 1024)
      throw new Error('auth-remote: state file exceeds the supported size')
    let renamed = false
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      await file.writeFile(bytes)
      await this.options.onStage?.('afterTempWrite')
      await file.sync()
      await this.options.onStage?.('afterFileSync')
      await file.close()
      file = undefined
      await this.options.onStage?.('beforeRename')
      await rename(temp, this.path)
      renamed = true
      await this.options.onStage?.('afterRename')
      const parent = await open(this.lock.dir, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
      await this.options.onStage?.('afterDirSync')
      const previous = this.state
      this.state = next
      await this.options.onCommitted?.(structuredClone(previous), structuredClone(next))
      for (const listener of this.listeners)
        await listener(structuredClone(previous), structuredClone(next))
      await this.options.onStage?.('beforeSuccess')
    } catch (error) {
      if (renamed) {
        this.unavailableReason = new Error('auth-remote: state commit outcome is uncertain', {
          cause: error,
        })
        this.options.onUnavailable?.(this.unavailableReason)
      }
      throw error
    } finally {
      await file?.close().catch(() => undefined)
      if (!renamed) await unlink(temp).catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.queue
    await this.lock.release()
  }
}
