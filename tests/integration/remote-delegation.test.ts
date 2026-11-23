import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AuthService } from '../../src/auth/service.js'
import { sessionHash } from '../../src/auth/sessions.js'
import { TOTP_PERIOD_MS, totpCode } from '../../src/auth/totp.js'
import { AuthStateStore, type CommitStage } from '../../src/storage/store.js'

const password = 'isolated delegation test password'

async function profile() {
  const dir = await mkdtemp(join(tmpdir(), 'auth-remote-delegation-'))
  let now = 30_000
  let inject: CommitStage | undefined
  let beforeRename: (() => void) | undefined
  const store = await AuthStateStore.open(dir, {
    onStage(stage) {
      if (stage === inject) throw new Error('simulated write error')
      if (stage === 'beforeRename') beforeRename?.()
    },
  })
  const auth = new AuthService(store, { sessionHours: 12, requireTotp: true }, { now: () => now })
  await auth.initialize('owner', password)
  const binding = await auth.login('owner', password)
  assert(binding.kind === 'binding')
  const { backupCodes } = await auth.confirmBinding(binding.challenge, totpCode(binding.secret, 1))
  const attempt = await auth.login('owner', password)
  assert(attempt.kind === 'mfa')
  const signed = await auth.verifyMfa(attempt.challenge, backupCodes[0]!)
  return {
    auth,
    store,
    owner: sessionHash(signed.token),
    ownerToken: signed.token,
    code: backupCodes[1]!,
    now: () => now,
    beforeRename(callback: () => void) {
      beforeRename = callback
    },
    get usedCodeCount() {
      return 10 - store.current().account!.totp!.backupCodeHashes.length
    },
    advance(delta: number) {
      now += delta
    },
    failAt(stage: CommitStage | undefined) {
      inject = stage
    },
    async close() {
      auth.dispose()
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('step-up validates the latest account and consumes a backup code only for a successful commit', async () => {
  const f = await profile()
  try {
    assert.equal(f.usedCodeCount, 1)
    await assert.rejects(
      f.auth.authorizeRemote(f.owner, undefined, async () => 'unexpected'),
      /invalid_factor/u,
    )
    await assert.rejects(
      f.auth.authorizeRemote(f.owner, f.code, async () => {
        throw new Error('upstream action was withdrawn')
      }),
      /withdrawn/u,
    )
    assert.equal(f.usedCodeCount, 1)
    f.failAt('beforeRename')
    await assert.rejects(
      f.auth.authorizeRemote(f.owner, f.code, async () => 'approved'),
      /simulated write error/u,
    )
    assert.equal(f.usedCodeCount, 1)
    f.failAt(undefined)
    assert.equal(await f.auth.authorizeRemote(f.owner, f.code, async () => 'approved'), 'approved')
    assert.equal(f.usedCodeCount, 2)
    await assert.rejects(
      f.auth.authorizeRemote(f.owner, f.code, async () => 'duplicate'),
      /invalid_factor/u,
    )
  } finally {
    await f.close()
  }
})

test('expiry during authorization prevents publication and never consumes the verification again', async () => {
  const f = await profile()
  try {
    await assert.rejects(
      f.auth.authorizeRemote(f.owner, f.code, async () => {
        f.advance(12 * 3_600_000)
        return 'approved'
      }),
      /conflict/u,
    )
    assert.equal(f.usedCodeCount, 1)
    await assert.rejects(f.auth.claimRemote(f.owner, 2, 7), /unauthorized/u)
  } finally {
    await f.close()
  }
})

test('a policy update queued during native authorization is observed before factor commit', async () => {
  const f = await profile()
  try {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const request = f.auth.authorizeRemote(f.owner, f.code, async () => {
      entered.resolve()
      await release.promise
      return 'approved'
    })
    await entered.promise
    const update = f.auth.applyPolicy({ requireTotp: true, sessionHours: 1 })
    release.resolve()
    await assert.rejects(request, /conflict/u)
    await update
    assert.equal(f.usedCodeCount, 1)
    f.advance(TOTP_PERIOD_MS)
    assert.equal(await f.auth.authorizeRemote(f.owner, f.code, async () => 'approved'), 'approved')
  } finally {
    await f.close()
  }
})

test('the claim rechecks the owning A session and account epoch inside the state lock', async () => {
  const f = await profile()
  try {
    const owner = f.auth.passwordSession(f.owner)!
    await assert.rejects(f.auth.claimRemote(f.owner, owner.securityVersion - 1, 7), /unauthorized/u)
    const delegated = await f.auth.claimRemote(f.owner, owner.securityVersion, 7)
    assert.equal(f.auth.session(delegated.token)?.source, 'delegated')
    await assert.rejects(
      f.auth.authorizeRemote(sessionHash(delegated.token), f.code, async () => 'approved'),
      /unauthorized/u,
    )
    await f.auth.logout(f.ownerToken)
    await assert.rejects(f.auth.claimRemote(f.owner, owner.securityVersion, 7), /unauthorized/u)
    assert(f.auth.session(delegated.token))
    await f.auth.resetTotp()
    assert.equal(f.auth.session(delegated.token), null)
  } finally {
    await f.close()
  }
})

test('queued or mid-write claims cannot commit after native expiry or unload', async () => {
  const f = await profile()
  try {
    const owner = f.auth.passwordSession(f.owner)!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const barrier = f.store.transact(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const delayed = f.auth.claimRemote(f.owner, owner.securityVersion, 7, f.now() + 1)
    f.advance(1)
    release.resolve()
    await barrier
    await assert.rejects(delayed, /unauthorized/u)
    const lifetime = new AbortController()
    f.beforeRename(() => lifetime.abort())
    await assert.rejects(
      f.auth.claimRemote(f.owner, owner.securityVersion, 7, f.now() + 1000, lifetime.signal),
      /unauthorized/u,
    )
    assert.equal(f.auth.status().activeSessions, 1)
  } finally {
    await f.close()
  }
})
