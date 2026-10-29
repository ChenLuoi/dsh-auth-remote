import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { testRuntime } from '../../scripts/runtime.mjs'

class LocalCarrierClosed extends Error {}

// Resolve only the selected host's shipped dependencies; this fixture replaces the Relay alone.
export async function localLiveShareRelay() {
  const runtime = createRequire(resolve(testRuntime, 'package.json'))
  const dsh = createRequire(runtime.resolve('@deepseek-ai/dsh/package.json'))
  const liveshare = createRequire(
    dsh.resolve('@deepseek-ai/dsh-experimental-liveshare/package.json'),
  )
  const { WebSocketServer } = liveshare('ws')

  const codes = new Map<string, { challenge: string; instance: string }>()
  const credentials = new Set<string>()
  const credentialInstances = new Map<string, string>()
  const shares = new Map<string, { socket: any; token: string }>()
  const tokens = new Map<string, string>()
  const carrierScripts = new Map<string, string>()
  const pending = new Map<
    number,
    { socket: any; resolve(value: any): void; reject(error: Error): void }
  >()
  const errors: string[] = []
  const actor = { providerId: 'fixture', tenantId: 'local', subjectId: 'reader' }
  let sequence = 0
  let exchanges = 0
  let authorityReads = 0
  let deletes = 0
  let viewerCalls = 0
  let closing = false
  let origin = ''
  let currentShare: string | undefined
  const json = (res: any, value: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const readJson = async (req: any) => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      assert(size <= 65536)
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const rpc = (shareId: string, body: unknown, signal?: AbortSignal) =>
    new Promise<any>((resolve, reject) => {
      const share = shares.get(shareId)
      if (!share || share.socket.readyState !== 1) {
        reject(new Error('local share unavailable'))
        return
      }
      const id = ++sequence
      const cleanup = () => {
        clearTimeout(timer)
        pending.delete(id)
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => {
        if (share.socket.readyState === 1)
          share.socket.send(JSON.stringify({ type: 'share-rpc-cancel', id }))
        pending.get(id)?.reject(new LocalCarrierClosed('viewer disconnected'))
      }
      const timer = setTimeout(() => {
        pending.get(id)?.reject(new Error('local owner RPC timeout'))
      }, 20000)
      pending.set(id, {
        socket: share.socket,
        resolve(value) {
          cleanup()
          resolve(value)
        },
        reject(error) {
          cleanup()
          reject(error)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      share.socket.send(JSON.stringify({ type: 'share-rpc', id, actor, body }))
    })
  const viewerRpc = async (res: any, shareId: string, body: unknown) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    try {
      return await rpc(shareId, body, controller.signal)
    } finally {
      res.off('close', abort)
    }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin)
      if (url.pathname === '/__liveshare/owner-credential' && req.method === 'GET') {
        const credential = req.headers['x-liveshare-owner-credential']
        if (credential && !credentials.has(String(credential)))
          return json(res, { error: 'unknown-credential' }, 401)
        return json(res, { supported: true })
      }
      if (url.pathname === '/__liveshare/owner-authorize' && req.method === 'GET') {
        const challenge = url.searchParams.get('code_challenge')!
        const instance = url.searchParams.get('instance')!
        assert(
          challenge && instance && url.searchParams.get('state') && url.searchParams.get('origin'),
        )
        const code = randomUUID()
        codes.set(code, { challenge, instance })
        return json(res, { code, state: url.searchParams.get('state') })
      }
      if (url.pathname === '/__liveshare/owner-credential' && req.method === 'POST') {
        const body = await readJson(req)
        const authorization = codes.get(body.code)
        if (!authorization) return json(res, { error: 'code-replayed' }, 403)
        assert.equal(body.instanceKey, authorization.instance)
        assert.equal(
          createHash('sha256').update(body.code_verifier).digest('base64url'),
          authorization.challenge,
        )
        codes.delete(body.code)
        exchanges++
        const credential =
          Buffer.from(
            JSON.stringify({
              expiresAt: Date.now() + 3600000,
              displayName: 'Local owner',
              subjectId: 'test-owner',
            }),
          ).toString('base64url') +
          '.' +
          randomUUID()
        credentials.add(credential)
        credentialInstances.set(credential, body.instanceKey)
        return json(res, { credential })
      }
      if (url.pathname === '/__liveshare/requests') {
        const share = shares.get(url.searchParams.get('shareId')!)
        assert(share)
        assert.equal(req.headers.authorization, `Bearer ${share.token}`)
        authorityReads++
        return json(res, {
          version: 1,
          accessMode: 'open',
          allowedSubjectIds: [],
          sessionMode: 'view',
          allowsFork: false,
        })
      }
      if (url.pathname === '/__liveshare/share' && req.method === 'DELETE') {
        assert.equal(
          req.headers.authorization,
          `Bearer ${tokens.get(url.searchParams.get('shareId')!)}`,
        )
        deletes++
        return json(res, { ok: true })
      }
      if (url.pathname === '/__liveshare/share/claim') {
        assert(credentials.has(String(req.headers['x-liveshare-owner-credential'])))
        return json(res, { claimed: true })
      }
      const shareId = url.searchParams.get('shareId') ?? currentShare
      if (!shareId || !shares.has(shareId)) return json(res, { error: 'share-not-found' }, 404)
      if (url.pathname === '/__share/rpc' && req.method === 'POST') {
        if (req.headers.cookie !== 'local-viewer=reader')
          return json(res, { error: 'viewer-unauthorized' }, 401)
        const answer = await viewerRpc(res, shareId, await readJson(req))
        if (answer.status === 200) viewerCalls++
        return json(res, answer.body, answer.status)
      }
      if (req.method !== 'GET') return json(res, { error: 'unsupported-local-relay-request' }, 405)
      // Select the actor in the fixture, never from an incoming viewer body or an owner Cookie.
      if (url.pathname === '/') {
        currentShare = shareId
        const answer = await viewerRpc(res, shareId, { op: 'asset', path: '' })
        if (answer.status !== 200) return json(res, answer.body, answer.status)
        const carrier = carrierScripts.get(shareId)
        assert(carrier, 'the real Node Host must supply the shipped viewer carrier')
        const html = Buffer.from(answer.body.base64, 'base64')
          .toString('utf8')
          .replace(
            /<head(?:\s[^>]*)?>/i,
            (open) =>
              `${open}<script>${carrier}\nwindow.__viewerTransportBefore = window.__DSH_TRANSPORT__;<\/script>`,
          )
        assert(
          html.includes('window.__viewerTransportBefore ='),
          'native viewer index has no head for its carrier',
        )
        res.writeHead(200, {
          'content-type': answer.body.contentType,
          'set-cookie': 'local-viewer=reader; SameSite=Lax; HttpOnly',
        })
        res.end(html)
        return
      }
      if (req.headers.cookie !== 'local-viewer=reader')
        return json(res, { error: 'viewer-unauthorized' }, 401)
      const answer = await viewerRpc(res, shareId, {
        op: 'asset',
        path: url.pathname.slice(1) + url.search,
      })
      if (answer.status !== 200) return json(res, answer.body, answer.status)
      res.writeHead(200, { 'content-type': answer.body.contentType })
      res.end(Buffer.from(answer.body.base64, 'base64'))
    } catch (error) {
      if (
        !closing &&
        !(error instanceof LocalCarrierClosed) &&
        !String(error).includes('local share unavailable')
      )
        errors.push(String(error))
      if (res.destroyed) return
      if (!res.headersSent) json(res, { error: 'local-relay-failed' }, 502)
      else res.destroy()
    }
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url!, origin)
      if (url.pathname === '/api/remote.mux') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      assert.equal(url.pathname, '/__tunnel_gateway__')
      assert(credentials.has(String(req.headers['x-liveshare-owner-credential'])))
      assert.equal(
        url.searchParams.get('ownerInstanceId'),
        credentialInstances.get(String(req.headers['x-liveshare-owner-credential'])),
      )
      assert.equal(url.searchParams.get('protocolVersion'), '1')
      const token = req.headers.authorization?.replace(/^Bearer /, '')
      assert(token)
      const shareId = url.searchParams.get('shareId')!
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        shares.set(shareId, { socket: ws, token })
        tokens.set(shareId, token)
        ws.on('message', (data: Buffer) => {
          const answer = JSON.parse(data.toString())
          if (answer.type !== 'share-rpc-res') return
          const waiter = pending.get(answer.id)
          if (waiter?.socket === ws) waiter.resolve(answer)
        })
        ws.on('close', () => {
          if (shares.get(shareId)?.socket === ws) shares.delete(shareId)
          for (const waiter of pending.values()) {
            if (waiter.socket === ws) waiter.reject(new LocalCarrierClosed('owner disconnected'))
          }
        })
      })
    } catch (error) {
      errors.push(String(error))
      socket.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    setCarrier(shareId: string, script: string) {
      carrierScripts.set(shareId, script)
    },
    rpc,
    shares,
    errors,
    counters: () => ({ exchanges, authorityReads, deletes, viewerCalls }),
    async close() {
      closing = true
      for (const wait of pending.values()) {
        wait.reject(new LocalCarrierClosed('local Relay closed'))
      }
      pending.clear()
      for (const client of wss.clients) client.terminate()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      assert.deepEqual(errors, [], 'unexpected local Relay errors')
    },
  }
}
