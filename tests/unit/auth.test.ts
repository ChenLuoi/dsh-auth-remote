import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AuthService, type AuthPolicy } from '../../src/auth/service.js'
import { hashPassword, validatePassword, verifyPassword } from '../../src/auth/password.js'
import { backupCodeHash, matchedTotpStep, totpCode } from '../../src/auth/totp.js'
import { AuthStateStore } from '../../src/storage/store.js'

const username = 'alice'
const password = 'secure password 123'
const replacement = 'new secure password 456'

async function fixture(policy: AuthPolicy = { requireTotp: true, sessionHours: 168 }) {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-auth-'))
  const store = await AuthStateStore.open(profile)
  let now = 90_000
  const auth = new AuthService(store, policy, { now: () => now })
  return {
    profile,
    store,
    auth,
    setNow(value: number) {
      now = value
    },
    advance(value: number) {
      now += value
    },
    now() {
      return now
    },
    async cleanup() {
      auth.dispose()
      await store.close()
      await rm(profile, { recursive: true, force: true })
    },
  }
}

async function bind(f: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  await f.auth.initialize(username, password)
  const login = await f.auth.login(username, password)
  assert.equal(login.kind, 'binding')
  if (login.kind !== 'binding') throw new Error('binding required')
  const step = Math.floor(f.now() / 30_000)
  const result = await f.auth.confirmBinding(login.challenge, totpCode(login.secret, step))
  f.advance(30_000)
  return result.backupCodes
}

test('password uses async scrypt, Unicode length rules and strict verification', async () => {
  assert.throws(() => validatePassword('短密码'), /12–256/u)
  assert.throws(() => validatePassword('x'.repeat(257)), /12–256/u)
  validatePassword('密'.repeat(12))
  const record = await hashPassword('密'.repeat(12))
  assert.match(record.salt, /^[a-f0-9]{64}$/u)
  assert.match(record.hash, /^[a-f0-9]{128}$/u)
  assert.equal(await verifyPassword('密'.repeat(12), record), true)
  assert.equal(await verifyPassword('密'.repeat(11) + '错', record), false)
})

test('standard TOTP vector, ±1 window, and a backup digest', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  assert.equal(totpCode(secret, 1), '287082') // RFC 6238 timestamp 59 seconds, six digits
  assert.equal(matchedTotpStep(secret, '287082', 59_000, null), 1)
  assert.equal(matchedTotpStep(secret, '287082', 59_000, 1), null)
  assert.equal(matchedTotpStep(secret, '287082', 60_000, null), 1)
  assert.equal(matchedTotpStep(secret, '287082', 90_000, null), null)
  assert.match(backupCodeHash('ABCDE-FGHIJ-KLMNO-PQRST') ?? '', /^[a-f0-9]{64}$/u)
})

test('optional MFA issues persistent fixed sessions and duplicate init never overwrites', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 1 })
  try {
    await f.auth.initialize(username, password)
    await assert.rejects(f.auth.initialize(username, replacement), /already_initialized/u)
    const login = await f.auth.login(username, password)
    assert.equal(login.kind, 'session')
    if (login.kind !== 'session') throw new Error('session required')
    assert.equal(f.auth.session(login.token)?.expiresAt, f.now() + 3_600_000)
    assert.equal(JSON.stringify(f.store.current()).includes(login.token), false)
    f.auth.dispose()
    await f.store.close()
    const reopened = await AuthStateStore.open(f.profile)
    const resumed = new AuthService(
      reopened,
      { requireTotp: false, sessionHours: 1 },
      { now: f.now },
    )
    try {
      assert.ok(resumed.session(login.token))
      f.advance(3_600_000)
      assert.equal(resumed.session(login.token), null)
    } finally {
      resumed.dispose()
      await reopened.close()
    }
  } finally {
    await f.cleanup()
  }
})

test('forced binding grants no business session; MFA and backup codes are one-use', async () => {
  const f = await fixture()
  try {
    const backupCodes = await bind(f)
    assert.equal(backupCodes.length, 10)
    assert.equal(f.auth.status().totpEnabled, true)
    const first = await f.auth.login(username, password)
    assert.equal(first.kind, 'mfa')
    if (first.kind !== 'mfa') throw new Error('MFA challenge required')
    const secret = f.store.current().account!.totp!.secret
    const code = totpCode(secret, Math.floor(f.now() / 30_000))
    const session = await f.auth.verifyMfa(first.challenge, code)
    assert.ok(f.auth.session(session.token))
    await assert.rejects(f.auth.verifyMfa(first.challenge, code), /invalid_challenge/u)
    const second = await f.auth.login(username, password)
    if (second.kind !== 'mfa') throw new Error('MFA challenge required')
    await assert.rejects(f.auth.verifyMfa(second.challenge, code), /invalid_factor/u)
    const backupSession = await f.auth.verifyMfa(second.challenge, backupCodes[0]!)
    assert.ok(f.auth.session(backupSession.token))
    assert.equal(f.store.current().account!.totp!.backupCodeHashes.length, 9)
    const third = await f.auth.login(username, password)
    if (third.kind !== 'mfa') throw new Error('MFA challenge required')
    await assert.rejects(f.auth.verifyMfa(third.challenge, backupCodes[0]!), /invalid_factor/u)
    assert.equal(f.auth.status().activeSessions, 2)
  } finally {
    await f.cleanup()
  }
})

test('MFA challenge expires, exhausts on fifth failure, and cannot be consumed twice concurrently', async () => {
  const f = await fixture()
  try {
    await bind(f)
    const expired = await f.auth.login(username, password)
    if (expired.kind !== 'mfa') throw new Error('MFA required')
    f.advance(5 * 60_000)
    await assert.rejects(f.auth.verifyMfa(expired.challenge, '000000'), /challenge_expired/u)
    const exhausted = await f.auth.login(username, password)
    if (exhausted.kind !== 'mfa') throw new Error('MFA required')
    for (let index = 0; index < 5; index++)
      await assert.rejects(f.auth.verifyMfa(exhausted.challenge, 'not-a-code'), /invalid_factor/u)
    await assert.rejects(f.auth.verifyMfa(exhausted.challenge, 'not-a-code'), /invalid_challenge/u)
    f.advance(60_000)
    const current = await f.auth.login(username, password)
    if (current.kind !== 'mfa') throw new Error('MFA required')
    const secret = f.store.current().account!.totp!.secret
    const code = totpCode(secret, Math.floor(f.now() / 30_000))
    const results = await Promise.allSettled([
      f.auth.verifyMfa(current.challenge, code),
      f.auth.verifyMfa(current.challenge, code),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(f.auth.status().activeSessions, 1)
  } finally {
    await f.cleanup()
  }
})

test('global limit counts wrong usernames, refuses the 11th, and derivations have no wait queue', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 1 })
  try {
    await f.auth.initialize(username, password)
    for (let index = 0; index < 10; index++)
      await assert.rejects(f.auth.login(`unknown-${index}`, password), /invalid_credentials/u)
    await assert.rejects(f.auth.login(username, password), /rate_limited/u)
    f.advance(60_000)
    const calls = [
      f.auth.login(username, password),
      f.auth.login(username, password),
      f.auth.login(username, password),
    ]
    const results = await Promise.allSettled(calls)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2)
    assert.ok(
      results.some((result) => result.status === 'rejected' && /busy/u.test(String(result.reason))),
    )
  } finally {
    await f.cleanup()
  }
})

test('policy tightening revokes unbound sessions and shortening cannot be undone by relaxing', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 10 })
  try {
    await f.auth.initialize(username, password)
    const first = await f.auth.login(username, password)
    if (first.kind !== 'session') throw new Error('session required')
    await f.auth.applyPolicy({ requireTotp: true, sessionHours: 10 })
    assert.equal(f.auth.session(first.token), null)
    const binding = await f.auth.login(username, password)
    assert.equal(binding.kind, 'binding')
    await f.auth.applyPolicy({ requireTotp: false, sessionHours: 10 })
    const second = await f.auth.login(username, password)
    if (second.kind !== 'session') throw new Error('session required')
    await f.auth.applyPolicy({ requireTotp: false, sessionHours: 1 })
    assert.equal(f.auth.session(second.token)?.expiresAt, f.now() + 3_600_000)
    await f.auth.applyPolicy({ requireTotp: false, sessionHours: 10 })
    assert.equal(f.auth.session(second.token)?.expiresAt, f.now() + 3_600_000)
  } finally {
    await f.cleanup()
  }
})

test('startup enforcement persists tightened policy before later relaxation', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 10 })
  try {
    await f.auth.initialize(username, password)
    const issued = await f.auth.login(username, password)
    if (issued.kind !== 'session') throw new Error('session required')
    f.auth.dispose()
    await f.store.close()
    const tightenedStore = await AuthStateStore.open(f.profile)
    const tightened = new AuthService(
      tightenedStore,
      { requireTotp: true, sessionHours: 1 },
      { now: f.now },
    )
    await tightened.enforceCurrentPolicy()
    assert.equal(tightened.session(issued.token), null)
    tightened.dispose()
    await tightenedStore.close()
    const relaxedStore = await AuthStateStore.open(f.profile)
    const relaxed = new AuthService(
      relaxedStore,
      { requireTotp: false, sessionHours: 10 },
      { now: f.now },
    )
    await relaxed.enforceCurrentPolicy()
    assert.equal(relaxed.session(issued.token), null)
    relaxed.dispose()
    await relaxedStore.close()
  } finally {
    await f.cleanup()
  }
})

test('startup session-hour reduction is durable across a later config increase', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 10 })
  try {
    await f.auth.initialize(username, password)
    const issued = await f.auth.login(username, password)
    if (issued.kind !== 'session') throw new Error('session required')
    f.auth.dispose()
    await f.store.close()
    const shortenedStore = await AuthStateStore.open(f.profile)
    const shortened = new AuthService(
      shortenedStore,
      { requireTotp: false, sessionHours: 1 },
      { now: f.now },
    )
    await shortened.enforceCurrentPolicy()
    assert.equal(shortened.session(issued.token)?.expiresAt, f.now() + 3_600_000)
    shortened.dispose()
    await shortenedStore.close()
    const laterStore = await AuthStateStore.open(f.profile)
    const later = new AuthService(
      laterStore,
      { requireTotp: false, sessionHours: 10 },
      { now: f.now },
    )
    await later.enforceCurrentPolicy()
    assert.equal(later.session(issued.token)?.expiresAt, f.now() + 3_600_000)
    later.dispose()
    await laterStore.close()
  } finally {
    await f.cleanup()
  }
})

test('password reset races cannot resurrect a session, and security changes revoke all devices', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 1 })
  try {
    await f.auth.initialize(username, password)
    const pending = f.auth.login(username, password)
    await f.store.transact((draft) => {
      draft.account!.securityVersion++
      draft.sessions = {}
    })
    await assert.rejects(pending, /conflict/u)
    const first = await f.auth.login(username, password)
    const second = await f.auth.login(username, password)
    if (first.kind !== 'session' || second.kind !== 'session') throw new Error('sessions required')
    await f.auth.changePassword(first.token, password, undefined, replacement)
    assert.equal(f.auth.session(first.token), null)
    assert.equal(f.auth.session(second.token), null)
    await assert.rejects(f.auth.login(username, password), /invalid_credentials/u)
    const renewed = await f.auth.login(username, replacement)
    if (renewed.kind !== 'session') throw new Error('session required')
    await f.auth.logout(renewed.token)
    assert.equal(f.auth.session(renewed.token), null)
    await f.auth.logout(renewed.token)
    await f.auth.resetPassword(password)
    assert.equal(f.auth.status().activeSessions, 0)
  } finally {
    await f.cleanup()
  }
})

test('failed rebind retains old factor; completed rebind and recovery clear all sessions', async () => {
  const f = await fixture()
  try {
    await bind(f)
    const oldSecret = f.store.current().account!.totp!.secret
    const login = await f.auth.login(username, password)
    if (login.kind !== 'mfa') throw new Error('MFA required')
    const code = totpCode(oldSecret, Math.floor(f.now() / 30_000))
    const issued = await f.auth.verifyMfa(login.challenge, code)
    f.advance(30_000)
    const rebind = await f.auth.startBinding(
      issued.token,
      password,
      totpCode(oldSecret, Math.floor(f.now() / 30_000)),
    )
    await assert.rejects(f.auth.confirmBinding(rebind.challenge, 'bad'), /invalid_factor/u)
    assert.equal(f.store.current().account!.totp!.secret, oldSecret)
    const changed = await f.auth.confirmBinding(
      rebind.challenge,
      totpCode(rebind.secret, Math.floor(f.now() / 30_000)),
    )
    assert.equal(changed.backupCodes.length, 10)
    assert.equal(f.auth.session(issued.token), null)
    assert.notEqual(f.store.current().account!.totp!.secret, oldSecret)
    await f.auth.resetTotp()
    assert.equal(f.store.current().account!.totp, null)
    assert.equal(f.auth.status().activeSessions, 0)
  } finally {
    await f.cleanup()
  }
})

test('binding challenge expires and fifth failure discards its secret without changing account', async () => {
  const f = await fixture()
  try {
    await f.auth.initialize(username, password)
    const expired = await f.auth.login(username, password)
    if (expired.kind !== 'binding') throw new Error('binding required')
    f.advance(10 * 60_000)
    await assert.rejects(
      f.auth.confirmBinding(
        expired.challenge,
        totpCode(expired.secret, Math.floor(f.now() / 30_000)),
      ),
      /challenge_expired/u,
    )
    const exhausted = await f.auth.login(username, password)
    if (exhausted.kind !== 'binding') throw new Error('binding required')
    for (let index = 0; index < 5; index++)
      await assert.rejects(f.auth.confirmBinding(exhausted.challenge, 'bad'), /invalid_factor/u)
    await assert.rejects(
      f.auth.confirmBinding(
        exhausted.challenge,
        totpCode(exhausted.secret, Math.floor(f.now() / 30_000)),
      ),
      /invalid_challenge/u,
    )
    assert.equal(f.auth.status().totpEnabled, false)
  } finally {
    await f.cleanup()
  }
})

test('bound sessions survive policy tightening; disabling MFA requires credentials and revokes them', async () => {
  const f = await fixture()
  try {
    await bind(f)
    const secret = f.store.current().account!.totp!.secret
    const challenge = await f.auth.login(username, password)
    if (challenge.kind !== 'mfa') throw new Error('MFA required')
    const token = (
      await f.auth.verifyMfa(challenge.challenge, totpCode(secret, Math.floor(f.now() / 30_000)))
    ).token
    await f.auth.applyPolicy({ requireTotp: false, sessionHours: 168 })
    assert.ok(f.auth.session(token))
    const stillMfa = await f.auth.login(username, password)
    assert.equal(stillMfa.kind, 'mfa')
    f.advance(30_000)
    await assert.rejects(f.auth.disableTotp(token, 'wrong password', 'bad'), /invalid_credentials/u)
    await assert.rejects(f.auth.disableTotp(token, password, 'bad'), /invalid_factor/u)
    assert.ok(f.auth.session(token))
    await f.auth.disableTotp(token, password, totpCode(secret, Math.floor(f.now() / 30_000)))
    assert.equal(f.auth.session(token), null)
    assert.equal(f.auth.status().totpEnabled, false)
    const plain = await f.auth.login(username, password)
    assert.equal(plain.kind, 'session')
  } finally {
    await f.cleanup()
  }
})

test('logout affects one device; verified global revoke clears every device', async () => {
  const f = await fixture({ requireTotp: false, sessionHours: 168 })
  try {
    await f.auth.initialize(username, password)
    const a = await f.auth.login(username, password)
    const b = await f.auth.login(username, password)
    if (a.kind !== 'session' || b.kind !== 'session') throw new Error('sessions required')
    await f.auth.logout(a.token)
    assert.equal(f.auth.session(a.token), null)
    assert.ok(f.auth.session(b.token))
    await assert.rejects(
      f.auth.revokeWithCredentials(b.token, 'wrong password'),
      /invalid_credentials/u,
    )
    assert.ok(f.auth.session(b.token))
    await f.auth.revokeWithCredentials(b.token, password)
    assert.equal(f.auth.session(b.token), null)
  } finally {
    await f.cleanup()
  }
})

test('pending MFA and binding cannot restore authentication after a recovery reset', async () => {
  const f = await fixture()
  try {
    await bind(f)
    const pending = await f.auth.login(username, password)
    if (pending.kind !== 'mfa') throw new Error('MFA required')
    const oldSecret = f.store.current().account!.totp!.secret
    const race = Promise.allSettled([
      f.auth.verifyMfa(pending.challenge, totpCode(oldSecret, Math.floor(f.now() / 30_000))),
      f.auth.revokeAll(),
    ])
    const results = await race
    const issued = results[0]
    if (issued?.status === 'fulfilled') assert.equal(f.auth.session(issued.value.token), null)
    assert.equal(f.auth.status().activeSessions, 0)
    await f.auth.resetTotp()
    const binding = await f.auth.login(username, password)
    if (binding.kind !== 'binding') throw new Error('binding required')
    await f.auth.resetPassword(replacement)
    await assert.rejects(
      f.auth.confirmBinding(
        binding.challenge,
        totpCode(binding.secret, Math.floor(f.now() / 30_000)),
      ),
      /invalid_challenge|conflict/u,
    )
    assert.equal(f.auth.status().totpEnabled, false)
  } finally {
    await f.cleanup()
  }
})

test('uncompleted challenge capacity is bounded and expired entries make room', async () => {
  const f = await fixture()
  try {
    await bind(f)
    f.advance(60_000)
    for (let index = 0; index < 32; index++) {
      if (index > 0 && index % 10 === 0) f.advance(60_000)
      const result = await f.auth.login(username, password)
      assert.equal(result.kind, 'mfa')
    }
    assert.equal(f.auth.pendingChallenges(), 32)
    await assert.rejects(f.auth.login(username, password), /busy/u)
    f.advance(120_000)
    assert.ok(f.auth.pendingChallenges() < 32)
    assert.equal((await f.auth.login(username, password)).kind, 'mfa')
  } finally {
    await f.cleanup()
  }
})

test('concurrent binding confirmation consumes one challenge exactly once', async () => {
  const f = await fixture()
  try {
    await f.auth.initialize(username, password)
    const challenge = await f.auth.login(username, password)
    if (challenge.kind !== 'binding') throw new Error('binding required')
    const code = totpCode(challenge.secret, Math.floor(f.now() / 30_000))
    const results = await Promise.allSettled([
      f.auth.confirmBinding(challenge.challenge, code),
      f.auth.confirmBinding(challenge.challenge, code),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(f.store.current().account!.securityVersion, 2)
    assert.equal(f.store.current().account!.totp!.backupCodeHashes.length, 10)
  } finally {
    await f.cleanup()
  }
})

test('bound account password change requires both factors and invalidates prior sessions', async () => {
  const f = await fixture()
  try {
    await bind(f)
    const secret = f.store.current().account!.totp!.secret
    const challenge = await f.auth.login(username, password)
    if (challenge.kind !== 'mfa') throw new Error('MFA required')
    const token = (
      await f.auth.verifyMfa(challenge.challenge, totpCode(secret, Math.floor(f.now() / 30_000)))
    ).token
    await assert.rejects(f.auth.disableTotp(token, password, 'bad'), /totp_required/u)
    f.advance(30_000)
    await assert.rejects(
      f.auth.changePassword(token, password, 'bad', replacement),
      /invalid_factor/u,
    )
    assert.ok(f.auth.session(token))
    await f.auth.changePassword(
      token,
      password,
      totpCode(secret, Math.floor(f.now() / 30_000)),
      replacement,
    )
    assert.equal(f.auth.session(token), null)
    await assert.rejects(f.auth.login(username, password), /invalid_credentials/u)
    assert.equal((await f.auth.login(username, replacement)).kind, 'mfa')
  } finally {
    await f.cleanup()
  }
})
