import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'

interface Attempt {
  id: string
  state: string
  redirect_uri: string
  code_challenge: string
  code: string
  cancelled: boolean
}

/** Local Platform stand-in: validates the real provider's redirect URI and PKCE. */
export async function accountPlatform() {
  const attempts: Attempt[] = []
  const exchanges: Record<string, string>[] = []
  const cancellations: string[] = []
  const requests: string[] = []
  const unexpected: string[] = []
  const failures: unknown[] = []
  const notificationEvents: { id: string; type: string }[] = []
  const notificationRequests: { path: string; locale: string }[] = []
  let failExchange = false
  let expiresIn = 600
  let holdExchange = false
  let releaseExchange: (() => void) | undefined
  let localizedNotifications = false
  const profile = {
    id: 'manual-test-user',
    email: 'manual@example.com',
    id_profile: { name: 'Manual Test Account', picture: null },
  }
  const send = (res: ServerResponse, value: unknown, code = 0) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { biz_code: code, biz_data: value } }))
  }
  const notification = {
    id: 'local-account-notice',
    created_at: '2026-11-13T00:00:00Z',
    display_until: null,
    title: 'Local account notification',
    body: 'Native notification content stays on the local fixture.',
    actions: [],
    data: { purpose: 'isolated-account-test' },
  }
  const notificationFor = (locale: string) =>
    localizedNotifications
      ? {
          ...notification,
          title: `${notification.title} [${locale}]`,
          body: `${notification.body} [${locale}]`,
          actions: [
            {
              label: `Account [${locale}]`,
              style: 'primary',
              target: { type: 'app_route', name: 'account' },
            },
          ],
        }
      : notification
  let origin = ''
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      requests.push(url.pathname)
      if (url.pathname === '/dsh/authorize') {
        assert.equal(req.method, 'GET')
        const attempt = attempts.find((row) => row.id === url.searchParams.get('id'))
        assert.ok(attempt)
        const callback = new URL(attempt.redirect_uri)
        callback.searchParams.set('code', attempt.code)
        callback.searchParams.set('state', attempt.state)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<html><title>Mock DeepSeek authorization</title><button onclick='location.href=${JSON.stringify(callback.href)}'>Authorize test account</button></html>`,
        )
        return
      }
      if (url.pathname === '/dsh/authorized') {
        assert.equal(req.method, 'GET')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><title>Local account authorized</title>Authorized test account</html>')
        return
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end()
        return
      }
      if (url.pathname === '/auth-api/v0/users/current') {
        send(res, profile)
        return
      }
      if (url.pathname === '/api/v0/users/get_user_summary') {
        send(res, { normal_wallets: [], bonus_wallets: [] })
        return
      }
      if (url.pathname === '/api/v0/users/get_unnotified_bonuses') {
        send(res, [])
        return
      }
      if (url.pathname.startsWith('/api/v0/users/notifications/')) {
        assert.equal(req.headers['x-dsh-auth-token'], 'dsh_mock_manual_account')
        notificationRequests.push({
          path: url.pathname,
          locale: String(req.headers['x-client-locale']),
        })
      }
      if (url.pathname === '/api/v0/users/notifications/list') {
        assert.equal(req.method, 'GET')
        send(res, {
          next_poll_after: 600,
          notifications: [notificationFor(String(req.headers['x-client-locale']))],
        })
        return
      }
      if (url.pathname === '/api/v0/users/notifications/content') {
        assert.equal(req.method, 'GET')
        assert.deepEqual(url.searchParams.getAll('id'), [notification.id])
        send(res, notificationFor(String(req.headers['x-client-locale'])))
        return
      }
      let text = ''
      for await (const chunk of req) text += String(chunk)
      const body = text ? (JSON.parse(text) as Record<string, string>) : {}
      if (url.pathname === '/api/v0/users/notifications/events') {
        assert.equal(req.method, 'POST')
        assert.equal(body.notification_id, notification.id)
        assert(['displayed', 'cta_clicked', 'dismissed'].includes(body.type!))
        notificationEvents.push({ id: body.notification_id!, type: body.type! })
        send(res, { acked: true })
      } else if (url.pathname === '/auth-api/v0/dsh/auth_init') {
        assert.equal(req.method, 'POST')
        assert.equal(body.code_challenge_method, 'S256')
        const attempt = {
          ...body,
          id: randomUUID(),
          code: randomBytes(24).toString('base64url'),
          cancelled: false,
        } as Attempt
        attempts.push(attempt)
        send(res, {
          authorize_id: attempt.id,
          authorize_url: `${origin}/dsh/authorize?id=${attempt.id}`,
          expires_in: expiresIn,
        })
      } else if (url.pathname === '/auth-api/v0/dsh/auth_cancel') {
        cancellations.push(body.authorize_id!)
        const attempt = attempts.find((row) => row.id === body.authorize_id)
        if (attempt) attempt.cancelled = true
        send(res, null)
      } else if (url.pathname === '/auth-api/v0/dsh/auth_exchange') {
        exchanges.push(body)
        const attempt = attempts.find((row) => row.code === body.code)
        assert.ok(attempt)
        assert.equal(attempt.cancelled, false)
        assert.equal(body.redirect_uri, attempt.redirect_uri)
        assert.equal(
          createHash('sha256').update(body.code_verifier!).digest('base64url'),
          attempt.code_challenge,
        )
        if (holdExchange)
          await new Promise<void>((resolve) => {
            releaseExchange = resolve
          })
        send(
          res,
          {
            token: 'dsh_mock_manual_account',
            user: profile,
            authorized_url: `${origin}/dsh/authorized`,
          },
          failExchange ? 17 : 0,
        )
      } else if (url.pathname === '/auth-api/v0/users/logout') send(res, null)
      else {
        unexpected.push(`${req.method} ${url.pathname}`)
        res.writeHead(404).end()
      }
    })().catch((error) => {
      failures.push(error)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    attempts,
    exchanges,
    cancellations,
    requests,
    notification,
    notificationFor,
    localizeNotifications() {
      localizedNotifications = true
    },
    notificationEvents,
    notificationRequests,
    callback(index = attempts.length - 1) {
      const attempt = attempts[index]!
      const callback = new URL(attempt.redirect_uri)
      callback.searchParams.set('code', attempt.code)
      callback.searchParams.set('state', attempt.state)
      return callback.href
    },
    failExchange(value = true) {
      failExchange = value
    },
    expiresIn(seconds: number) {
      expiresIn = seconds
    },
    holdExchange(value = true) {
      holdExchange = value
      if (!value) releaseExchange?.()
    },
    async close() {
      releaseExchange?.()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      assert.deepEqual(unexpected, [], 'Unexpected local Platform requests')
      assert.deepEqual(failures, [], 'Local Platform protocol validation failed')
    },
  }
}
