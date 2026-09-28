import { lstat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  ADMIN_MAX_BYTES,
  ADMIN_PROTOCOL_VERSION,
  type AdminRequest,
  type AdminResponse,
} from '../shared/admin-contract.js'
import { CliDiagnostic } from './language.js'

type AdminResult = Extract<AdminResponse, { ok: true }>['result']

export class AdminUnavailable extends Error {
  constructor() {
    super('dsh-auth-remote: management socket is unavailable')
  }
}

export class AdminOutcomeUnknown extends Error {
  constructor() {
    super('dsh-auth-remote: management request disconnected or timed out; result is unknown')
  }
}

export class AdminRejected extends Error {
  constructor(readonly code: string) {
    super(`dsh-auth-remote: ${code}`)
  }
}

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function inspectSocket(path: string): Promise<boolean> {
  let directory
  try {
    directory = await lstat(dirname(path))
  } catch (error) {
    if (errno(error, 'ENOENT')) return false
    throw error
  }
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700
  )
    throw new CliDiagnostic(
      'cliErrorUnsafeManagementDirectory',
      'dsh-auth-remote: unsafe management directory',
    )
  let socket
  try {
    socket = await lstat(path)
  } catch (error) {
    if (errno(error, 'ENOENT')) return false
    throw error
  }
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600)
    throw new CliDiagnostic(
      'cliErrorUnsafeManagementSocket',
      'dsh-auth-remote: unsafe management socket',
    )
  return true
}

/** Only pre-connect absence may fall back to the offline state lock. */
export async function requestAdmin(path: string, request: AdminRequest): Promise<AdminResult> {
  if (!(await inspectSocket(path))) throw new AdminUnavailable()
  let socket: Socket
  try {
    socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(path)
      candidate.setTimeout(2_000, () => {
        candidate.destroy()
        reject(new AdminUnavailable())
      })
      candidate.once('connect', () => {
        candidate.setTimeout(0)
        resolve(candidate)
      })
      candidate.once('error', reject)
    })
  } catch (error) {
    if (errno(error, 'ENOENT') || errno(error, 'ECONNREFUSED')) throw new AdminUnavailable()
    throw error
  }
  try {
    return await new Promise<AdminResult>((resolve, reject) => {
      let bytes = 0
      const chunks: Buffer[] = []
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
        socket.destroy()
      }
      socket.setTimeout(30_000, () => fail(new AdminOutcomeUnknown()))
      socket.on('error', () => fail(new AdminOutcomeUnknown()))
      socket.on('end', () => {
        if (!settled) fail(new AdminOutcomeUnknown())
      })
      socket.on('data', (chunk: Buffer) => {
        if (settled) return
        bytes += chunk.length
        if (bytes > ADMIN_MAX_BYTES) return fail(new AdminOutcomeUnknown())
        chunks.push(chunk)
        const data = Buffer.concat(chunks)
        const newline = data.indexOf(10)
        if (newline < 0) return
        if (newline !== data.length - 1) return fail(new AdminOutcomeUnknown())
        let response: unknown
        try {
          response = JSON.parse(data.subarray(0, newline).toString('utf8'))
        } catch {
          return fail(new AdminOutcomeUnknown())
        }
        if (
          typeof response !== 'object' ||
          response === null ||
          !('version' in response) ||
          response.version !== ADMIN_PROTOCOL_VERSION ||
          !('ok' in response) ||
          typeof response.ok !== 'boolean'
        )
          return fail(new AdminOutcomeUnknown())
        const reply = response as AdminResponse
        settled = true
        socket.end()
        if (reply.ok) resolve(reply.result)
        else reject(new AdminRejected(reply.error))
      })
      socket.write(`${JSON.stringify(request)}\n`)
    })
  } finally {
    socket.destroy()
  }
}
