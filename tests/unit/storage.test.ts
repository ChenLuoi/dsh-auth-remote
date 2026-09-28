import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { AuthStateStore, type CommitStage } from '../../src/storage/store.js'
import { LOCK_FILE, STATE_DIR, STATE_FILE } from '../../src/storage/lock.js'
import { validateState } from '../../src/storage/state.js'
import { AuthRemoteWebServer } from '../../src/index.js'

const accountId = 'a'.repeat(32)
const password = { salt: 'b'.repeat(64), hash: 'c'.repeat(128) }

async function fixture(): Promise<{ profile: string; cleanup: () => Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-store-'))
  return { profile, cleanup: () => rm(profile, { recursive: true, force: true }) }
}

function child(mode: string, profile: string, stage?: CommitStage): ChildProcess {
  return spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      new URL('../fixtures/storage-child.mjs', import.meta.url).pathname,
      mode,
      profile,
      ...(stage ? [stage] : []),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

async function exitCode(process: ChildProcess): Promise<number | null> {
  const [code] = (await once(process, 'exit')) as [number | null]
  return code
}

test('state schema rejects corruption, unknown versions and malformed session records', () => {
  const valid = {
    schemaVersion: 1,
    revision: 1,
    account: { id: accountId, username: 'alice', password, totp: null, securityVersion: 1 },
    sessions: { ['a'.repeat(64)]: { accountId, securityVersion: 1, createdAt: 1, expiresAt: 2 } },
  }
  assert.deepEqual(validateState(valid).revision, 1)
  assert.throws(() => validateState({ ...valid, schemaVersion: 2 }), /unsupported state schema/u)
  assert.throws(() => validateState({ ...valid, surprise: true }), /invalid state fields/u)
  assert.throws(
    () => validateState({ ...valid, sessions: { token: { accountId } } }),
    /session token hash/u,
  )
  assert.throws(
    () =>
      validateState({
        ...valid,
        sessions: {
          ['a'.repeat(64)]: { accountId, securityVersion: 1, createdAt: 2, expiresAt: 2 },
        },
      }),
    /lifetime/u,
  )
})

test('real files use private modes and serialized transactions do not lose updates', async () => {
  const f = await fixture()
  try {
    const events: number[] = []
    const store = await AuthStateStore.open(f.profile, {
      onCommitted: (_, next) => {
        events.push(next.revision)
      },
    })
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.transact(async (draft) => {
            if (index % 2 === 0) await Promise.resolve()
            draft.account ??= {
              id: accountId,
              username: 'alice',
              password,
              totp: null,
              securityVersion: 1,
            }
            draft.account.securityVersion += 1
          }),
        ),
      )
      assert.equal(store.current().revision, 20)
      assert.equal(store.current().account?.securityVersion, 21)
      assert.deepEqual(
        events,
        Array.from({ length: 20 }, (_, index) => index + 1),
      )
      assert.equal((await stat(join(f.profile, STATE_DIR))).mode & 0o777, 0o700)
      assert.equal((await stat(store.path)).mode & 0o777, 0o600)
      assert.equal((await stat(join(f.profile, STATE_DIR, LOCK_FILE))).mode & 0o777, 0o600)
      assert.equal(validateState(JSON.parse(await readFile(store.path, 'utf8'))).revision, 20)
    } finally {
      await store.close()
    }
    const reopened = await AuthStateStore.open(f.profile)
    assert.equal(reopened.current().revision, 20)
    await reopened.close()
  } finally {
    await f.cleanup()
  }
})

test('pre-rename faults preserve prior memory and disk; post-rename faults close admission', async () => {
  const f = await fixture()
  try {
    let fail: CommitStage | undefined
    let unavailable = 0
    const store = await AuthStateStore.open(f.profile, {
      onStage(stage) {
        if (stage === fail) throw new Error(`injected ${stage}`)
      },
      onUnavailable() {
        unavailable++
      },
    })
    try {
      await store.transact((draft) => {
        draft.account = { id: accountId, username: 'old', password, totp: null, securityVersion: 1 }
      })
      const oldBytes = await readFile(store.path, 'utf8')
      for (const stage of ['afterTempWrite', 'afterFileSync', 'beforeRename'] as const) {
        fail = stage
        await assert.rejects(
          store.transact((draft) => {
            draft.account!.username = 'new'
          }),
          /injected/u,
        )
        assert.equal(store.current().account?.username, 'old')
        assert.equal(await readFile(store.path, 'utf8'), oldBytes)
        assert.equal(store.healthy(), true)
      }
      fail = 'afterRename'
      await assert.rejects(
        store.transact((draft) => {
          draft.account!.username = 'new'
        }),
        /injected/u,
      )
      assert.equal(store.healthy(), false)
      assert.equal(unavailable, 1)
      assert.throws(() => store.current(), /uncertain/u)
      await assert.rejects(
        store.transact(() => undefined),
        /uncertain/u,
      )
    } finally {
      await store.close()
    }
    const reopened = await AuthStateStore.open(f.profile)
    assert.equal(reopened.current().account?.username, 'new')
    await reopened.close()
  } finally {
    await f.cleanup()
  }
})

test('directory-sync uncertainty fails closed and success waits for revocation notification', async () => {
  const f = await fixture()
  try {
    const uncertain = await AuthStateStore.open(f.profile, {
      onStage(stage) {
        if (stage === 'afterDirSync') throw new Error('injected directory sync completion fault')
      },
    })
    await assert.rejects(
      uncertain.transact((draft) => {
        draft.account = {
          id: accountId,
          username: 'alice',
          password,
          totp: null,
          securityVersion: 1,
        }
      }),
      /injected directory sync/u,
    )
    assert.equal(uncertain.healthy(), false)
    await uncertain.close()

    let notify: (() => void) | undefined
    const notified = new Promise<void>((resolve) => {
      notify = resolve
    })
    let notificationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      notificationStarted = resolve
    })
    const recovered = await AuthStateStore.open(f.profile, {
      async onCommitted() {
        notificationStarted?.()
        await notified
      },
    })
    try {
      assert.equal(recovered.current().account?.username, 'alice')
      let settled = false
      const operation = recovered.transact((draft) => {
        draft.account!.username = 'bob'
      })
      void operation.then(() => {
        settled = true
      })
      await started
      assert.equal(settled, false)
      assert.equal(
        validateState(JSON.parse(await readFile(recovered.path, 'utf8'))).account?.username,
        'bob',
      )
      notify?.()
      await operation
      assert.equal(settled, true)
    } finally {
      await recovered.close()
    }
  } finally {
    await f.cleanup()
  }
})

test('live child lock blocks service and offline writer; dead owner can be proven and reclaimed', async () => {
  const f = await fixture()
  const holder = child('hold', f.profile)
  try {
    assert.match(String((await once(holder.stdout!, 'data'))[0]), /READY/u)
    await assert.rejects(AuthStateStore.open(f.profile), /live process/u)
    holder.kill('SIGKILL')
    await exitCode(holder)
    const recovered = await AuthStateStore.open(f.profile)
    await recovered.close()
  } finally {
    holder.kill('SIGKILL')
    await f.cleanup()
  }
})

test('crashes at each commit phase recover only whole old or new snapshots', async () => {
  for (const stage of [
    'afterTempWrite',
    'afterFileSync',
    'beforeRename',
    'afterRename',
    'afterDirSync',
    'beforeSuccess',
  ] as const) {
    const f = await fixture()
    try {
      const seed = await AuthStateStore.open(f.profile)
      await seed.transact((draft) => {
        draft.account = { id: accountId, username: 'old', password, totp: null, securityVersion: 1 }
      })
      await seed.close()
      const worker = child('crash', f.profile, stage)
      assert.equal(await exitCode(worker), 77)
      const recovered = await AuthStateStore.open(f.profile)
      try {
        const state = recovered.current()
        assert.equal(
          state.account?.id,
          stage === 'afterTempWrite' || stage === 'afterFileSync' || stage === 'beforeRename'
            ? accountId
            : 'c'.repeat(32),
        )
        assert.equal(state.revision, state.account?.id === accountId ? 1 : 2)
      } finally {
        await recovered.close()
      }
    } finally {
      await f.cleanup()
    }
  }
})

test('damaged JSON, unsupported version and insecure files fail closed without replacement', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.profile, STATE_DIR), { mode: 0o700 })
    const path = join(f.profile, STATE_DIR, STATE_FILE)
    await writeFile(path, '{bad', { mode: 0o600 })
    await assert.rejects(AuthStateStore.open(f.profile), /JSON/u)
    assert.equal(await readFile(path, 'utf8'), '{bad')
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 99, revision: 0, account: null, sessions: {} }),
    )
    await assert.rejects(AuthStateStore.open(f.profile), /unsupported state schema/u)
    await chmod(path, 0o644)
    await assert.rejects(AuthStateStore.open(f.profile), /unsafe file permissions/u)
  } finally {
    await f.cleanup()
  }
})

test('formal service holds the same lock before listening and releases it on disposal', async () => {
  const f = await fixture()
  const ctx = new Context()
  ctx.provide('profileContext', { dir: f.profile } as never)
  ctx.provide('webStartup', { host: '127.0.0.1', port: 0 } as never)
  try {
    await ctx.plugin(AuthRemoteWebServer, {
      allowedOrigins: ['http://auth-remote.test:13090'],
    })
    await ctx.fiber.await()
    const server = ctx.webServer
    assert.ok(server.port > 0)
    assert.equal(server instanceof AuthRemoteWebServer, true)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/auth-remote/ready',
          headers: { host: 'auth-remote.test:13090' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 503)
    await assert.rejects(AuthStateStore.open(f.profile), /live process/u)
    await ctx.fiber.dispose()
    const offline = await AuthStateStore.open(f.profile)
    await offline.close()
  } finally {
    await ctx.fiber.dispose()
    await f.cleanup()
  }
})
