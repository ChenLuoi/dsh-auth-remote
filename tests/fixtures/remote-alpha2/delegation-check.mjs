import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { requestAdmin } from '../../../src/cli/ipc-client.ts'
import { totpCode, TOTP_PERIOD_MS } from '../../../src/auth/totp.ts'
import { nativeHttp, nativeRequest, nativeStream } from '../../helpers/native-http.ts'

const authPath = '/auth-remote'
const delegation = authPath + '/delegation'
const day = 86_400_000
const parse = (response) => JSON.parse(response.body)

function pluginCookie(response) {
  const cookies = response.headers['set-cookie']
  assert.equal(cookies?.length, 1)
  assert(cookies[0].startsWith('dsh_auth_remote='))
  assert(cookies[0].includes('; Secure'))
  return cookies[0].split(';', 1)[0]
}

export async function checkDelegation(
  address,
  externalHeaders,
  adminPath,
  password,
  upgrade,
  setPhase,
) {
  const get = (path, cookie) => nativeHttp(address, path, { ...externalHeaders, cookie })
  const post = (path, body, cookie) =>
    nativeHttp(address, path, {
      ...externalHeaders,
      cookie,
      method: 'POST',
      body: JSON.stringify(body),
    })
  const rpc = (name, args, cookie) => {
    const method = 'remoteConnection/' + name
    return post(
      '/api/' + method,
      { type: 'client-request', rpcId: randomUUID(), method, payload: { args } },
      cookie,
    )
  }
  const newInvite = (cookie, fields = {}) =>
    post(delegation, { requestId: randomUUID(), ...fields }, cookie)
  const scan = (ticket) =>
    nativeHttp(address, '/?login=qr', {
      ...externalHeaders,
      method: 'POST',
      body: new URL(ticket.url).hash.slice(1),
      headers: { 'content-type': 'text/plain' },
    })
  const startPair = async () => {
    const request = { id: randomUUID(), secret: randomBytes(32).toString('base64url') }
    const response = await post('/pairing/request', request)
    assert.equal(response.status, 200)
    const issued = parse(response)
    assert(issued.id === request.id && /^[A-Z2-9]{8}$/u.test(issued.code))
    return {
      request,
      code: issued.code,
      pollAt: Date.now() + issued.pollIntervalMs,
      pollMs: issued.pollIntervalMs,
    }
  }
  const waitPoll = (pairing) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, pairing.pollAt - Date.now())))
  async function session(cookie, days) {
    const result = await get(authPath + '/me', cookie)
    assert.equal(result.status, 200)
    const value = parse(result)
    assert.equal(value.expiresAt - value.createdAt, days * day)
    assert.equal(parse(await get(delegation, cookie)).canAuthorize, false)
    return value.expiresAt
  }
  async function denied(name, args, cookie) {
    const result = await rpc(name, args, cookie)
    assert.equal(result.status, 200)
    assert.equal(parse(result).result.ok, false)
  }

  setPhase('unbound A uses native QR with default duration and one current invitation')
  await requestAdmin(adminPath, { version: 1, command: 'init', username: 'owner', password })
  let owner = pluginCookie(await post(authPath + '/login', { username: 'owner', password }))
  assert.deepEqual(parse(await get(delegation, owner)), { canAuthorize: true, totpEnabled: false })
  assert.equal((await newInvite(owner, { days: 2 })).status, 400)
  const older = parse(await newInvite(owner)).result
  const qrReply = await newInvite(owner)
  assert.equal(qrReply.status, 200)
  const later = parse(qrReply).result
  assert(later.lifetimeMs > 115_000 && later.lifetimeMs <= 120_000)
  assert.equal((await scan(older)).status, 410)
  const collected = await scan(later)
  assert.equal(collected.status, 204)
  const firstB = pluginCookie(collected)
  await session(firstB, 3)
  assert.equal((await scan(later)).status, 410)
  const cancelled = parse(await newInvite(owner)).result
  const cancelledReply = await rpc('cancel', { id: cancelled.id }, owner)
  assert.equal(parse(cancelledReply).result.value, 'cancelled')
  assert.equal((await scan(cancelled)).status, 410)
  const unclaimed = parse(await newInvite(owner)).result

  setPhase('pairing cancel after a failed session commit cannot issue a cookie')
  const failedPair = await startPair()
  assert.equal((await newInvite(owner, { pairingId: failedPair.request.id })).status, 200)
  await waitPoll(failedPair)
  assert.equal((await post('/__provider/fail-next-state-write', {}, owner)).status, 204)
  const failed = await post('/pairing/status', failedPair.request)
  assert.equal(failed.status, 503)
  assert.equal(failed.headers['set-cookie'], undefined)
  const cancelledPair = await post('/pairing/cancel', failedPair.request)
  assert.equal(parse(cancelledPair).status, 'cancelled')
  assert.equal(cancelledPair.headers['set-cookie'], undefined)
  assert.equal(parse(await get(authPath + '/me', owner)).activeSessions, 2)

  setPhase('binding factors revokes old generations and credential use is scoped')
  const start = await post(authPath + '/totp/start', { password }, owner)
  assert.equal(start.status, 200)
  const binding = parse(start)
  const step = Math.floor(Date.now() / TOTP_PERIOD_MS)
  const confirmed = await post(
    authPath + '/totp/confirm',
    {
      challenge: binding.challenge,
      code: totpCode(binding.secret, step),
    },
    owner,
  )
  assert.equal(confirmed.status, 200)
  const { backupCodes } = parse(confirmed)
  assert.equal((await scan(unclaimed)).status, 410)
  assert.equal((await get('/', firstB)).status, 401)
  const challenge = parse(await post(authPath + '/login', { username: 'owner', password }))
  assert.equal(challenge.kind, 'mfa')
  owner = pluginCookie(
    await post(authPath + '/mfa/verify', { challenge: challenge.challenge, code: backupCodes[0] }),
  )
  assert.deepEqual(parse(await get(delegation, owner)), { canAuthorize: true, totpEnabled: true })
  await denied('create', {}, owner)

  const paired = await startPair()
  await denied('decidePairing', { id: paired.request.id, decision: 'allow' }, owner)
  const queue = parse(await rpc('pairingRequests', {}, owner)).result
  assert(
    queue.ok &&
      queue.value.requests.some(
        (item) => item.id === paired.request.id && item.code === paired.code && item.sourceIp,
      ),
  )
  const qr = { requestId: randomUUID(), days: 7, code: totpCode(binding.secret, step + 1) }
  const [first, duplicate] = await Promise.all([
    post(delegation, qr, owner),
    post(delegation, qr, owner),
  ])
  assert.equal(first.status, 200)
  assert.equal(duplicate.status, 200)
  const firstTicket = parse(first).result
  const duplicateTicket = parse(duplicate).result
  assert(firstTicket.id === duplicateTicket.id && firstTicket.url === duplicateTicket.url)
  await new Promise((resolve) => setTimeout(resolve, 90))
  const retriedTicket = parse(await post(delegation, qr, owner)).result
  assert(retriedTicket.id === firstTicket.id && retriedTicket.url === firstTicket.url)
  assert(retriedTicket.lifetimeMs < firstTicket.lifetimeMs)
  assert.equal((await post(delegation, { ...qr, days: 1 }, owner)).status, 409)
  assert.equal((await newInvite(owner, { code: qr.code })).status, 401)
  const approval = {
    requestId: randomUUID(),
    pairingId: paired.request.id,
    days: 1,
    code: backupCodes[1],
  }
  setPhase('a failed approval commit leaves the original request pending and retryable')
  assert.equal((await post('/__provider/fail-next-state-write', {}, owner)).status, 204)
  assert.equal((await post(delegation, approval, owner)).status, 503)
  const afterFailure = parse(await rpc('pairingRequests', {}, owner)).result
  assert(
    afterFailure.ok &&
      afterFailure.value.requests.some(
        (item) => item.id === paired.request.id && item.code === paired.code,
      ),
    'the original code must remain pending after a failed approval commit',
  )
  await waitPoll(paired)
  const pendingReply = await post('/pairing/status', paired.request)
  assert.equal(pendingReply.status, 200)
  assert.equal(parse(pendingReply).status, 'pending')
  assert.equal(pendingReply.headers['set-cookie'], undefined)
  paired.pollAt = Date.now() + paired.pollMs
  const [allow, retry] = await Promise.all([
    post(delegation, approval, owner),
    post(delegation, approval, owner),
  ])
  assert.equal(allow.status, 200)
  assert.equal(retry.status, 200)
  assert.equal(parse(allow).result, 'approved')
  const invite = parse(first).result

  setPhase('two native exchanges issue separate B sessions')
  await waitPoll(paired)
  const discardPairingResponse = async () => {
    const body = JSON.stringify(paired.request)
    const request = nativeRequest(address, '/pairing/status', {
      ...externalHeaders,
      method: 'POST',
      body,
    })
    request.setTimeout(8000, () => request.destroy(new Error('pairing response timed out')))
    const landed = once(request, 'response')
    request.end(body)
    const [response] = await landed
    const observed = { headers: response.headers, status: response.statusCode }
    // Emulate losing the successful delivery before storing its cookie.
    response.destroy()
    return observed
  }
  const began = Date.now()
  const [scanned, discarded] = await Promise.all([scan(invite), discardPairingResponse()])
  const firstCompletedAt = Date.now()
  assert.equal(scanned.status, 204)
  assert.equal(discarded.status, 200)
  await new Promise((resolve) => setTimeout(resolve, paired.pollMs))
  const polled = await post('/pairing/status', paired.request)
  assert.equal(polled.status, 200)
  assert.equal(parse(polled).status, 'completed')
  const qrB = pluginCookie(scanned)
  const pairB = pluginCookie(polled)
  assert(qrB !== pairB)
  assert(pairB === pluginCookie(discarded))
  await session(qrB, 7)
  const deadline = await session(pairB, 1)
  assert(deadline >= began + day && deadline <= firstCompletedAt + day)
  for (const cookie of [qrB, pairB]) {
    await denied('create', {}, cookie)
    await denied('pairingRequests', {}, cookie)
    await denied('decidePairing', { id: paired.request.id, decision: 'allow' }, cookie)
    await denied('cancel', { id: invite.id }, cookie)
    assert.equal((await newInvite(cookie)).status, 401)
  }
  assert.equal((await scan(invite)).status, 410)

  setPhase('A logout withdraws unclaimed approval, preserves issued B and retry')
  const pending = await startPair()
  const approved = await newInvite(owner, { pairingId: pending.request.id, code: backupCodes[2] })
  assert.equal(approved.status, 200)
  assert.equal((await post(authPath + '/logout', {}, owner)).status, 200)
  await waitPoll(pending)
  assert.equal(parse(await post('/pairing/status', pending.request)).status, 'expired')
  const retried = await post('/pairing/status', paired.request)
  assert.equal(parse(retried).status, 'completed')
  assert(pluginCookie(retried) === pairB)
  assert.equal(await session(pairB, 1), deadline)

  setPhase('B self-service cancellation and global long-connection revocation')
  const ownRequest = await startPair()
  assert.equal(parse(await post('/pairing/cancel', ownRequest.request, pairB)).status, 'cancelled')
  assert.equal((await post(authPath + '/logout', {}, qrB)).status, 200)
  assert.equal((await get('/', qrB)).status, 401)
  assert.equal((await get('/', pairB)).status, 200)
  const sse = await nativeStream(address, '/__provider/stream', {
    ...externalHeaders,
    cookie: pairB,
  })
  const admitted = await upgrade(address, { ...externalHeaders, cookie: pairB })
  assert.equal(admitted.status, 101)
  const closed = once(admitted.socket, 'close')
  try {
    await requestAdmin(adminPath, { version: 1, command: 'revoke-sessions' })
    await Promise.race([
      Promise.all([closed, sse.closed]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('revocation timed out')), 3000).unref(),
      ),
    ])
    assert.equal((await get('/', pairB)).status, 401)
  } finally {
    sse.close()
    admitted.socket.destroy()
  }
}
