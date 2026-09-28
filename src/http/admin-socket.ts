import { createServer, type Server, type Socket } from 'node:net'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { PasswordValidationError } from '../auth/password.js'
import { AuthError, AuthService } from '../auth/service.js'
import {
  ADMIN_MAX_BYTES,
  ADMIN_PROTOCOL_VERSION,
  type AdminRequest,
  type AdminResponse,
  type AdminStatus,
} from '../shared/admin-contract.js'
import { STATE_DIR } from '../storage/lock.js'

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function validRequest(value: unknown): AdminRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version !== ADMIN_PROTOCOL_VERSION || typeof row.command !== 'string') return null
  const allowed: Record<string, readonly string[]> = {
    status: ['version', 'command'],
    init: ['version', 'command', 'username', 'password'],
    'reset-password': ['version', 'command', 'password'],
    'reset-totp': ['version', 'command'],
    'revoke-sessions': ['version', 'command'],
  }
  const fields = allowed[row.command]
  if (
    !fields ||
    Object.keys(row).length !== fields.length ||
    Object.keys(row).some((key) => !fields.includes(key))
  )
    return null
  if (
    row.command === 'init' &&
    (typeof row.username !== 'string' || typeof row.password !== 'string')
  )
    return null
  if (row.command === 'reset-password' && typeof row.password !== 'string') return null
  return row as AdminRequest
}

function failure(error: unknown): AdminResponse {
  return {
    version: ADMIN_PROTOCOL_VERSION,
    ok: false,
    error:
      error instanceof PasswordValidationError
        ? 'invalid_input'
        : error instanceof AuthError
          ? error.code
          : 'service_unavailable',
  }
}

/** Single-request local protocol. The state lock must already be held before start(). */
export class AdminSocket {
  readonly path: string
  private server: Server | undefined
  private inode: bigint | undefined
  private readonly sockets = new Set<Socket>()
  private readonly operations = new Set<Promise<void>>()

  constructor(
    profileDir: string,
    private readonly auth: AuthService,
    private readonly ready: () => boolean,
    private readonly onUnavailable: () => void,
  ) {
    this.path = join(profileDir, STATE_DIR, 'admin.sock')
  }

  async start(): Promise<void> {
    try {
      const stale = await lstat(this.path, { bigint: true })
      if (
        !stale.isSocket() ||
        stale.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stale.mode & 0o777n) !== 0o600n
      )
        throw new Error('auth-remote: unsafe admin socket path; manual review required')
      await unlink(this.path)
    } catch (error) {
      if (!errno(error, 'ENOENT')) throw error
    }
    const server = createServer((socket) => this.accept(socket))
    server.on('error', () => this.onUnavailable())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    await chmod(this.path, 0o600)
    const info = await lstat(this.path, { bigint: true })
    if (
      !info.isSocket() ||
      info.uid !== BigInt(process.getuid?.() ?? -1) ||
      (info.mode & 0o777n) !== 0o600n
    )
      throw new Error('auth-remote: unsafe admin socket permissions')
    this.inode = info.ino
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => this.sockets.delete(socket))
    socket.setTimeout(10_000, () => socket.destroy())
    let chunks: Buffer[] = []
    let bytes = 0
    let received = false
    socket.on('data', (chunk: Buffer) => {
      if (received) return
      bytes += chunk.length
      if (bytes > ADMIN_MAX_BYTES) {
        received = true
        socket.end(JSON.stringify({ version: 1, ok: false, error: 'request_too_large' }) + '\n')
        return
      }
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      const newline = all.indexOf(10)
      if (newline < 0) return
      received = true
      socket.setTimeout(0)
      if (newline !== all.length - 1) {
        socket.end(JSON.stringify({ version: 1, ok: false, error: 'invalid_request' }) + '\n')
        return
      }
      chunks = []
      let request: AdminRequest | null
      try {
        request = validRequest(JSON.parse(all.subarray(0, newline).toString('utf8')))
      } catch {
        request = null
      }
      if (!request) {
        socket.end(JSON.stringify({ version: 1, ok: false, error: 'invalid_request' }) + '\n')
        return
      }
      const operation = this.respond(socket, request)
      this.operations.add(operation)
      void operation.finally(() => this.operations.delete(operation))
    })
  }

  private async respond(socket: Socket, request: AdminRequest): Promise<void> {
    let response: AdminResponse
    try {
      switch (request.command) {
        case 'status': {
          const status: AdminStatus = { ...this.auth.status(), online: true, ready: this.ready() }
          response = { version: 1, ok: true, result: status }
          break
        }
        case 'init':
          await this.auth.initialize(request.username, request.password)
          response = { version: 1, ok: true, result: { ok: true } }
          break
        case 'reset-password':
          await this.auth.resetPassword(request.password)
          response = { version: 1, ok: true, result: { ok: true } }
          break
        case 'reset-totp':
          await this.auth.resetTotp()
          response = { version: 1, ok: true, result: { ok: true } }
          break
        case 'revoke-sessions':
          await this.auth.revokeAll()
          response = { version: 1, ok: true, result: { ok: true } }
      }
    } catch (error) {
      response = failure(error)
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`)
  }

  async dispose(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of this.sockets) socket.destroy()
      await Promise.allSettled(this.operations)
      await closed
    }
    if (this.inode !== undefined) {
      try {
        const current = await lstat(this.path, { bigint: true })
        if (current.isSocket() && current.ino === this.inode) await unlink(this.path)
      } catch (error) {
        if (!errno(error, 'ENOENT')) throw error
      }
      this.inode = undefined
    }
  }
}
