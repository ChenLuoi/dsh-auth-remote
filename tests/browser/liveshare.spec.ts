import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { dshVersion, testRuntime } from '../../scripts/runtime.mjs'
import { packedAdmin, packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { launchBrowser } from '../helpers/runtime.js'
import { localLiveShareRelay } from '../helpers/liveshare-relay.js'
import {
  nativeHttp,
  nativeCertPath,
  nativeKeyPath,
  nativeCertificate,
} from '../helpers/native-http.js'
import { startForwarder, type Forwarder } from '../helpers/proxy.js'

if (dshVersion === '0.2.2-alpha.2')
  test(
    'liveshare: native viewer carrier and index retain non-owner transport and administrator client is inert',
    { timeout: 90_000 },
    async () => {
      const f = await packedProfile({ requireTotp: false, port: 0 })
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        await packedAdmin(f.home, 'init', [
          ['Username: ', 'alice'],
          ['Password: ', 'isolated viewer password'],
          ['Enter password again: ', 'isolated viewer password'],
        ])
        const fixture = join(f.profile, 'liveshare-viewer.mjs')
        await copyFile(new URL('../fixtures/liveshare-viewer.mjs', import.meta.url), fixture)
        const patch = join(f.profile, 'cordis.patch.yml')
        await writeFile(
          patch,
          (await readFile(patch, 'utf8')) +
            `- insert:\n    - id: liveshare-viewer-fixture\n      name: ${fixture}\n      inject: [webServer, connection, profileContext]\n`,
        )
        server = packedCommand(f.home, ['web', '--no-open', '--port', '0'], f.cwd)
        const active = server
        let origin = ''
        await expect
          .poll(
            async () => {
              if (active.child.exitCode !== null) throw new Error(active.output().stderr)
              origin = /http:\/\/127\.0\.0\.1:[0-9]+/u.exec(active.output().stdout)?.[0] ?? ''
              return origin
                ? fetch(origin + '/auth-remote/ready')
                    .then((r) => r.status)
                    .catch(() => 0)
                : 0
            },
            { timeout: 30_000 },
          )
          .toBe(200)
        browser = await launchBrowser()
        const context = await browser.newContext()
        const login = await context.request.post(origin + '/auth-remote/login', {
          headers: { origin },
          data: { username: 'alice', password: 'isolated viewer password' },
        })
        assert.equal(login.status(), 200, await login.text())
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        // Observe the real module factory/apply without changing its dependencies or behavior.
        await page.addInitScript({
          path: new URL('../fixtures/liveshare-client-observer.js', import.meta.url).pathname,
        })
        const authRequests: string[] = []
        page.on('request', (req) => {
          if (new URL(req.url()).pathname.startsWith('/auth-remote/')) authRequests.push(req.url())
        })
        const documentResponse = await page.goto(origin + '/liveshare-fixture')
        assert.equal(documentResponse?.status(), 200, active.output().stderr)
        try {
          await expect
            .poll(() => page.evaluate(() => Boolean((window as any).__authRemoteExports)))
            .toBe(true)
        } catch (error) {
          console.error(
            'Viewer boot facts:',
            await page.evaluate(() => {
              const w = window as any
              return {
                baseline: w.__DSH_REMOTE_ACCESS__,
                transport: Object.keys(w.__DSH_TRANSPORT__ ?? {}),
                loader: Object.keys(w.__ModuleLoader__ ?? {}),
                text: document.body.innerText.slice(0, 1500),
                scripts: Array.from(document.scripts).map((script) => script.src),
                mode: w.__ModuleLoader__?.mode,
              }
            }),
          )
          console.error('Host errors:', active.output().stderr)
          throw error
        }
        const facts = await page.evaluate(() => {
          const w = window as any
          const before = w.__viewerTransportBefore
          return {
            same: before === w.__DSH_TRANSPORT__,
            fetch: before?.fetch === w.__DSH_TRANSPORT__?.fetch,
            stream: before?.openStream === w.__DSH_TRANSPORT__?.openStream,
            hasFetch: typeof before?.fetch,
            hasStream: typeof before?.openStream,
            ownsHost: w.__DSH_TRANSPORT__?.ownsHost,
            manual: w.__DSH_AUTH_REMOTE_MANUAL_ACCOUNT_LOGIN__,
            baseline: w.__DSH_REMOTE_ACCESS__,
            applies: w.__authRemoteApplies ?? 0,
          }
        })
        assert.ok(facts.applies >= 1, 'native Loader did not activate the real client entry')
        assert.equal(facts.same, true)
        assert.equal(facts.fetch, true)
        assert.equal(facts.stream, true)
        assert.equal(facts.hasFetch, 'function')
        assert.equal(facts.hasStream, 'function')
        assert.notEqual(facts.ownsHost, true)
        assert.equal(facts.manual, undefined)
        assert.equal(facts.baseline.owner, false)
        // Explicit calls also prove the full entry exits before touching any Context API.
        await page.evaluate(() => {
          const w = window as any
          const remembered = localStorage.getItem('dsh-auth-remote-lang')
          const sentinel = new Proxy(
            {},
            {
              get() {
                throw new Error('non-owner touched administrator Context')
              },
            },
          )
          for (const baseline of [
            { type: 'baseline', owner: false, grants: [] },
            null,
            {},
            { type: 'baseline', owner: 'true' },
          ]) {
            w.__DSH_REMOTE_ACCESS__ = baseline
            w.__authRemoteExports.apply(sentinel)
          }
          if (localStorage.getItem('dsh-auth-remote-lang') !== remembered) {
            throw new Error('non-owner changed language memory')
          }
        })
        assert.equal(await page.locator('style[data-plugin="dsh-auth-remote"]').count(), 0)
        await page.waitForTimeout(1200)
        assert.deepEqual(authRequests, [])
        assert.deepEqual(pageErrors, [])
        assert.equal(new URL(page.url()).pathname, '/liveshare-fixture')
      } finally {
        await browser?.close()
        await server?.stop()
        await f.cleanup()
      }
    },
  )

if (dshVersion === '0.2.2-alpha.2')
  for (const ingress of ['native-https', 'https-http-proxy'] as const)
    test(
      `liveshare: ${ingress} real Owner PKCE login, native share worker, viewer and stop keep independent lifetimes`,
      { timeout: 150_000 },
      async () => {
        const relay = await localLiveShareRelay()
        const publicOrigin = 'https://auth-remote.test:13150'
        const f = await packedProfile({
          requireTotp: false,
          port: 13151,
          publicUrl: publicOrigin,
        })
        let server: ReturnType<typeof packedCommand> | undefined
        let proxy: Forwarder | undefined
        let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
        try {
          const password = 'isolated liveshare owner password'
          await packedAdmin(f.home, 'init', [
            ['Username: ', 'alice'],
            ['Password: ', password],
            ['Enter password again: ', password],
          ])
          const runtime = createRequire(resolve(testRuntime, 'package.json'))
          const dsh = createRequire(runtime.resolve('@deepseek-ai/dsh/package.json'))
          assert.equal(
            dsh('@deepseek-ai/dsh-experimental-liveshare/package.json').version,
            dshVersion,
          )
          const probe = join(f.profile, 'liveshare-session.mjs')
          await copyFile(new URL('../fixtures/liveshare-session.mjs', import.meta.url), probe)
          const patch = join(f.profile, 'cordis.patch.yml')
          await writeFile(
            patch,
            (await readFile(patch, 'utf8')) +
              `- insert:\n    - id: liveshare-viewer-declarations\n      name: '@deepseek-ai/dsh-experimental-liveshare/viewer-declarations'\n    - id: liveshare-share-host\n      name: '@deepseek-ai/dsh-experimental-liveshare'\n      config:\n        ownerStateFile: ${JSON.stringify(join(f.profile, 'test-liveshare-state.json'))}\n        ownerCredentialFile: ${JSON.stringify(join(f.profile, 'test-liveshare-credential.json'))}\n    - id: liveshare-session-fixture\n      name: ${JSON.stringify(probe)}\n      inject: [webServer, sessions, profileContext, liveshareShares]\n`,
          )
          server = packedCommand(
            f.home,
            [
              'web',
              '--no-open',
              '--port',
              '13151',
              ...(ingress === 'native-https'
                ? ['--tls-cert', nativeCertPath, '--tls-key', nativeKeyPath]
                : []),
            ],
            f.cwd,
          )
          const active = server
          let target = ''
          await expect
            .poll(
              async () => {
                if (active.child.exitCode !== null) throw new Error(active.output().stderr)
                target = /https?:\/\/127\.0\.0\.1:[0-9]+/u.exec(active.output().stdout)?.[0] ?? ''
                return target
                  ? nativeHttp(target, '/auth-remote/ready', {
                      host: new URL(publicOrigin).host,
                      origin: publicOrigin,
                    })
                      .then((r) => r.status)
                      .catch(() => 0)
                  : 0
              },
              { timeout: 30000 },
            )
            .toBe(200)
          if (ingress === 'https-http-proxy') {
            proxy = await startForwarder({
              listenPort: 13150,
              upstreamPort: Number(new URL(target).port),
              tls: { cert: nativeCertificate, key: await readFile(nativeKeyPath) },
            })
            target = 'https://127.0.0.1:13150'
          }
          const options = { host: new URL(publicOrigin).host, origin: publicOrigin, method: 'POST' }
          const login = async () => {
            const answer = await nativeHttp(target, '/auth-remote/login', {
              ...options,
              body: JSON.stringify({ username: 'alice', password }),
            })
            assert.equal(answer.status, 200, answer.body)
            return answer.headers['set-cookie']![0]!.split(';')[0]!
          }
          let cookie = await login()
          const rpc = async (method: string, args: Record<string, unknown> = {}) => {
            const endpoint = `liveshareShares/${method}`
            const answer = await nativeHttp(target, '/api/' + endpoint, {
              ...options,
              cookie,
              body: JSON.stringify({
                type: 'client-request',
                rpcId: randomUUID(),
                method: endpoint,
                payload: { args },
              }),
            })
            assert.equal(answer.status, 200, answer.body + active.output().stderr)
            const result = JSON.parse(answer.body).result
            assert.equal(result.ok, true, answer.body)
            return result.value
          }
          await rpc('setRelay', { request: { relayUrl: relay.origin } })
          const session = await nativeHttp(target, '/plugins/liveshare-fixture/session', {
            ...options,
            cookie,
          })
          assert.equal(session.status, 200, session.body + active.output().stderr)
          const sessionId = JSON.parse(session.body).sessionId
          await assert.rejects(rpc('create', { request: { sessionId } }), /owner-login-required/u)
          assert.equal(relay.shares.size, 0)
          const start = async () => {
            const answer = await nativeHttp(target, '/api/liveshare.ownerLoginStart', {
              ...options,
              cookie,
            })
            assert.equal(answer.status, 200, answer.body)
            const transaction = JSON.parse(answer.body)
            const url = new URL(transaction.authorizeUrl)
            assert.equal(url.origin, relay.origin)
            assert.equal(url.searchParams.get('origin'), publicOrigin)
            assert.equal(url.searchParams.get('state'), transaction.state)
            assert.equal(url.searchParams.has('code_verifier'), false)
            return transaction
          }
          const cancelled = await start()
          const cancellation = await nativeHttp(target, '/api/liveshare.ownerLoginCancel', {
            ...options,
            cookie,
            body: JSON.stringify({ state: cancelled.state }),
          })
          assert.equal(JSON.parse(cancellation.body).cancelled, true)
          const cancelledRedeem = await nativeHttp(target, '/api/liveshare.ownerLoginRedeem', {
            ...options,
            cookie,
            body: JSON.stringify({ state: cancelled.state, code: 'unused' }),
          })
          assert.equal(cancelledRedeem.status, 403)
          const transaction = await start()
          const consent = (await (await fetch(transaction.authorizeUrl)).json()) as { code: string }
          const wrongState = await nativeHttp(target, '/api/liveshare.ownerLoginRedeem', {
            ...options,
            cookie,
            body: JSON.stringify({ state: 'wrong-state', code: consent.code }),
          })
          assert.equal(wrongState.status, 403)
          assert.equal(relay.counters().exchanges, 0)
          const redeem = await nativeHttp(target, '/api/liveshare.ownerLoginRedeem', {
            ...options,
            cookie,
            body: JSON.stringify({ state: transaction.state, code: consent.code }),
          })
          assert.equal(redeem.status, 200, redeem.body)
          assert.equal(JSON.parse(redeem.body).state, 'verified')
          assert.equal(Object.hasOwn(JSON.parse(redeem.body), 'credential'), false)
          assert.equal(relay.counters().exchanges, 1)
          const replay = await nativeHttp(target, '/api/liveshare.ownerLoginRedeem', {
            ...options,
            cookie,
            body: JSON.stringify({ state: transaction.state, code: consent.code }),
          })
          assert.equal(replay.status, 403)
          const created = await rpc('create', {
            request: {
              sessionId,
              sessionTitle: 'Local shared session',
              sessionMode: 'view',
              allowsFork: false,
            },
          })
          assert.equal(created.sessionId, sessionId)
          const list = await rpc('list')
          assert.equal(list.shares[0].shareId, created.shareId)
          assert.equal(list.shares[0].online, true)
          assert.ok(relay.counters().authorityReads > 0)
          const rawIndex = await relay.rpc(created.shareId, { op: 'asset', path: '' })
          assert.equal(rawIndex.status, 200)
          assert.match(
            Buffer.from(rawIndex.body.base64, 'base64').toString('utf8'),
            /__DSH_REMOTE_ACCESS__/u,
          )
          const carrier = await nativeHttp(
            target,
            '/plugins/liveshare-fixture/carrier?shareId=' +
              encodeURIComponent(created.shareId) +
              '&sessionId=' +
              encodeURIComponent(sessionId),
            { ...options, method: 'GET', cookie },
          )
          assert.equal(carrier.status, 200, carrier.body)
          relay.setCarrier(created.shareId, carrier.body)
          browser = await launchBrowser()
          const context = await browser.newContext()
          const page = await context.newPage()
          const pageErrors: string[] = []
          page.on('pageerror', (error) => pageErrors.push(error.message))
          await page.addInitScript({
            path: new URL('../fixtures/liveshare-client-observer.js', import.meta.url).pathname,
          })
          const authRequests: string[] = []
          page.on('request', (req) => {
            if (new URL(req.url()).pathname.startsWith('/auth-remote/'))
              authRequests.push(req.url())
          })
          await page.goto(
            relay.origin +
              '/?shareId=' +
              encodeURIComponent(created.shareId) +
              '&sessionId=' +
              encodeURIComponent(sessionId),
          )
          await expect
            .poll(() => page.evaluate(() => (window as any).__authRemoteApplies ?? 0), {
              timeout: 15000,
            })
            .toBeGreaterThan(0)
          assert.deepEqual(
            await page.evaluate(() => {
              const w = window as any
              return {
                owner: w.__DSH_REMOTE_ACCESS__.owner,
                same: w.__viewerTransportBefore === w.__DSH_TRANSPORT__,
                fetch: typeof w.__DSH_TRANSPORT__?.fetch,
                stream: typeof w.__DSH_TRANSPORT__?.openStream,
                manual: w.__DSH_AUTH_REMOTE_MANUAL_ACCOUNT_LOGIN__,
              }
            }),
            { owner: false, same: true, fetch: 'function', stream: 'function', manual: undefined },
          )
          assert.equal(await page.locator('style[data-plugin="dsh-auth-remote"]').count(), 0)
          assert.deepEqual(authRequests, [])
          await expect.poll(() => relay.counters().viewerCalls).toBeGreaterThan(0)
          await browser.close()
          assert.deepEqual(pageErrors, [])
          browser = undefined
          const logout = await nativeHttp(target, '/auth-remote/logout', { ...options, cookie })
          assert.equal(logout.status, 200)
          assert.equal((await relay.rpc(created.shareId, { op: 'asset', path: '' })).status, 200)
          assert.equal(
            (await nativeHttp(target, '/api/liveshare.ownerLoginStart', { ...options, cookie }))
              .status,
            401,
          )
          cookie = await login()
          assert.equal((await rpc('stop', { request: { shareId: created.shareId } })).ok, true)
          await expect.poll(() => relay.shares.has(created.shareId)).toBe(false)
          assert.ok(relay.counters().deletes > 0)
          assert.equal((await fetch(relay.origin + '/?shareId=' + created.shareId)).status, 404)
          for (const rejected of [
            { cookie: undefined },
            { cookie, origin: 'https://evil.example' },
            { cookie, origin: null },
            { cookie, headers: { 'sec-fetch-site': 'cross-site' } },
          ]) {
            const answer = await nativeHttp(target, '/api/liveshare.ownerLoginStart', {
              ...options,
              ...rejected,
            })
            assert.equal(answer.status, rejected.cookie === undefined ? 401 : 403)
            assert.equal(
              JSON.parse(answer.body).error,
              rejected.cookie === undefined ? 'unauthorized' : 'invalid_origin',
            )
          }
          const duplicate = await new Promise<{ status: number; body: string }>(
            (resolve, reject) => {
              const req = httpsRequest(
                new URL('/api/liveshare.ownerLoginStart', target),
                {
                  method: 'POST',
                  ca: nativeCertificate,
                  agent: false,
                  headers: [
                    'Host',
                    new URL(publicOrigin).host,
                    'Origin',
                    publicOrigin,
                    'Origin',
                    publicOrigin,
                    'Cookie',
                    cookie,
                  ],
                },
                (res) => {
                  const chunks: Buffer[] = []
                  res.on('data', (chunk) => chunks.push(chunk))
                  res.on('end', () =>
                    resolve({
                      status: res.statusCode!,
                      body: Buffer.concat(chunks).toString('utf8'),
                    }),
                  )
                },
              )
              req.on('error', reject)
              req.end()
            },
          )
          assert.equal(duplicate.status, 403)
          assert.equal(JSON.parse(duplicate.body).error, 'invalid_origin')
          const observeOrigin = async () => {
            const transaction = await start()
            const response = await nativeHttp(
              target,
              '/plugins/liveshare-fixture/origin-observation',
              { ...options, method: 'GET', cookie },
            )
            assert.equal(response.status, 200, response.body)
            const observed = JSON.parse(response.body)
            assert.equal(observed.observation.status, 200)
            assert.equal(
              observed.observation.writes.length,
              3,
              'bridge and one public-Origin restoration pair',
            )
            assert.equal(observed.observation.writes[1], publicOrigin)
            assert.equal(observed.observation.writes[0], observed.observation.writes[2])
            await nativeHttp(target, '/api/liveshare.ownerLoginCancel', {
              ...options,
              cookie,
              body: JSON.stringify({ state: transaction.state }),
            })
            return observed.generation
          }
          const beforeHmr = await observeOrigin()
          await writeFile(
            patch,
            (await readFile(patch, 'utf8')).replace(
              /^( +)requireTotp: false$/mu,
              '$&\n$1sessionHours: 169',
            ),
          )
          await expect
            .poll(
              async () => {
                const response = await nativeHttp(
                  target,
                  '/plugins/liveshare-fixture/origin-observation',
                  { ...options, method: 'GET', cookie },
                ).catch(() => undefined)
                return response?.status === 200 ? JSON.parse(response.body).generation : beforeHmr
              },
              { timeout: 30000 },
            )
            .not.toBe(beforeHmr)
          assert.notEqual(await observeOrigin(), beforeHmr)
          assert.equal(relay.counters().exchanges, 1)
        } finally {
          await browser?.close()
          await server?.stop()
          await proxy?.close()
          await f.cleanup()
          await relay.close()
        }
      },
    )
