import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const STATE_DIR = 'auth-remote'
export const STATE_FILE = 'auth-state.json'
export const LOCK_FILE = 'auth-state.lock'

interface Owner {
  pid: number
  bootId: string
  startTicks: string
  nonce: string
}

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function processStartTicks(pid: number): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (errno(error, 'ENOENT')) return null
    throw error
  }
  const tail = raw
    .slice(raw.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u)
  const ticks = tail[19]
  if (!ticks || !/^\d+$/u.test(ticks)) throw new Error('auth-remote: cannot verify lock owner')
  return ticks
}

async function localOwner(): Promise<Owner> {
  const [bootId, startTicks] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    processStartTicks(process.pid),
  ])
  if (!startTicks) throw new Error('auth-remote: cannot verify own process identity')
  return { pid: process.pid, bootId: bootId.trim(), startTicks, nonce: randomUUID() }
}

function parseOwner(raw: string): Owner {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('auth-remote: lock owner is unreadable; manual recovery required')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('auth-remote: lock owner is invalid; manual recovery required')
  const owner = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.bootId !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(owner.bootId) ||
    typeof owner.startTicks !== 'string' ||
    !/^\d+$/u.test(owner.startTicks) ||
    typeof owner.nonce !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(owner.nonce)
  )
    throw new Error('auth-remote: lock owner is invalid; manual recovery required')
  return owner as unknown as Owner
}

async function isDead(owner: Owner, currentBootId: string): Promise<boolean> {
  if (owner.bootId !== currentBootId) return true
  const ticks = await processStartTicks(owner.pid)
  return ticks === null || ticks !== owner.startTicks
}

async function assertPrivate(path: string, kind: 'directory' | 'file'): Promise<void> {
  const info = await lstat(path)
  if (
    (kind === 'directory' ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)
  )
    throw new Error(`auth-remote: unsafe ${kind} permissions or owner: ${path}`)
}

export async function ensureStateDirectory(profileDir: string): Promise<string> {
  if (process.platform !== 'linux') throw new Error('auth-remote: storage requires Linux /proc')
  const dir = join(profileDir, STATE_DIR)
  let created = false
  try {
    await mkdir(dir, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!errno(error, 'EEXIST')) throw error
  }
  await assertPrivate(dir, 'directory')
  if (created) {
    const parent = await open(profileDir, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }
  return dir
}

/** Lock recovery uses a second exclusive directory, so reclaimers cannot erase one another's new lock. */
export class StateLock {
  private released = false

  private constructor(
    readonly dir: string,
    readonly path: string,
    private readonly owner: Owner,
  ) {}

  static async acquire(profileDir: string): Promise<StateLock> {
    const dir = await ensureStateDirectory(profileDir)
    const path = join(dir, LOCK_FILE)
    const owner = await localOwner()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await file.writeFile(JSON.stringify(owner))
          await file.sync()
        } catch (error) {
          await file.close()
          await unlink(path).catch(() => undefined)
          throw error
        }
        await file.close()
        return new StateLock(dir, path, owner)
      } catch (error) {
        if (!errno(error, 'EEXIST')) throw error
        if (attempt === 1) throw new Error('auth-remote: state lock is held or contested')
        await this.recoverStale(dir, path, owner.bootId)
      }
    }
    throw new Error('auth-remote: state lock acquisition failed')
  }

  private static async recoverStale(
    dir: string,
    path: string,
    currentBootId: string,
  ): Promise<void> {
    const recovery = `${path}.recovery`
    try {
      await mkdir(recovery, { mode: 0o700 })
    } catch (error) {
      if (errno(error, 'EEXIST'))
        throw new Error(
          'auth-remote: lock recovery is already active or abandoned; manual review required',
        )
      throw error
    }
    try {
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if (errno(error, 'ENOENT')) return
        throw error
      }
      await assertPrivate(path, 'file')
      const old = parseOwner(await readFile(path, 'utf8'))
      if (!(await isDead(old, currentBootId)))
        throw new Error(`auth-remote: state lock held by live process ${old.pid}`)
      const latest = await lstat(path)
      if (latest.ino !== info.ino || latest.dev !== info.dev)
        throw new Error('auth-remote: state lock changed during recovery')
      await unlink(path)
      const parent = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    } finally {
      await rmdir(recovery)
    }
  }

  async release(): Promise<void> {
    if (this.released) return
    const current = parseOwner(await readFile(this.path, 'utf8'))
    if (current.nonce !== this.owner.nonce)
      throw new Error('auth-remote: state lock ownership changed before release')
    await unlink(this.path)
    this.released = true
  }
}

export async function assertPrivateStateFile(path: string): Promise<void> {
  await assertPrivate(path, 'file')
}
