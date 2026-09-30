import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { startForwarder, type Forwarder } from '../helpers/proxy.js'
import { archive, completeApiKeyPrompt, dsh, launchBrowser, project } from '../helpers/runtime.js'

const publicPort = 13100
const dshPort = 13101
const relayPort = 13102
const publicHost = `auth-remote.test:${publicPort}`
const origin = `https://${publicHost}`
const directOrigin = `http://127.0.0.1:${relayPort}`
const password = 'proxy browser password 123'

function testEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    LANG: 'C.UTF-8',
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function run(command: string, args: string[], home: string): Promise<void> {
  const child = spawn(command, args, {
    cwd: home,
    env: testEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'close')) as [number]
  if (code !== 0) throw new Error(`${command} failed: ${stderr.slice(0, 1500)}`)
}

async function initialize(home: string): Promise<void> {
  const command = [
    dsh,
    'plugin',
    '--profile',
    'web',
    'exec',
    'dsh-auth-remote',
    'init',
    '--lang',
    'zh',
  ]
    .map(quote)
    .join(' ')
  const child = spawn('script', ['-q', '-e', '-f', '-c', command, '/dev/null'], {
    cwd: home,
    env: testEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const prompts = [
    ['用户名: ', 'alice'],
    ['密码: ', password],
    ['再次输入密码: ', password],
  ] as const
  let output = ''
  let cursor = 0
  let index = 0
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    while (index < prompts.length) {
      const [label, answer] = prompts[index]!
      const found = output.indexOf(label, cursor)
      if (found < 0) break
      cursor = found + label.length
      index++
      child.stdin.write(`${answer}\n`)
    }
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  const [code] = (await once(child, 'close')) as [number]
  clearTimeout(timer)
  assert.equal(code, 0, output.slice(0, 1500))
  assert.equal(output.includes(password), false)
}

function proxyRequest(
  path: string,
  options: {
    method?: string
    origin?: string
    cookie?: string
    body?: Buffer
    accept?: string
    contentType?: string
  } = {},
) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port: publicPort,
          path,
          method: options.method ?? 'GET',
          rejectUnauthorized: false,
          headers: {
            host: publicHost,
            ...(options.origin ? { origin: options.origin } : {}),
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.accept ? { accept: options.accept } : {}),
            ...(options.body
              ? {
                  'content-type': options.contentType ?? 'application/octet-stream',
                  'content-length': options.body.length,
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(options.body)
    },
  )
}

test('Node HTTPS and HTTP forwarding preserve public authority and guarded transport', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-proxy-'))
  const profile = join(home, 'profiles/web')
  let server: ReturnType<typeof spawn> | undefined
  let relay: Forwarder | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let proxy: Forwarder | undefined
  let mock: ReturnType<typeof createHttpServer> | undefined
  const modelRequests: { method: string; path: string }[] = []
  try {
    await run(dsh, ['plugin', '--profile', 'web', 'add', archive], home)
    await mkdir(join(home, 'workspace'))
    await writeFile(join(home, 'workspace/proxy-note.md'), '# Proxy Preview\n\n来自官方预览。\n')
    const fixtureDir = join(home, 'strict-fixture')
    await mkdir(fixtureDir)
    await writeFile(
      join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'auth-remote-strict-fixture', version: '0.0.0', type: 'module' }),
    )
    const fixture = join(fixtureDir, 'index.mjs')
    await copyFile(new URL('../fixtures/strict-origin-fixture.mjs', import.meta.url), fixture)
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        '- id: webserver',
        '  disabled: true',
        '- id: auth-remote',
        '  config:',
        `    allowedOrigins: [${origin}]`,
        '    requireTotp: false',
        '    sessionHours: 168',
        '    preserveOriginPaths: [/api, /plugins/public]',
        '- insert:',
        '    - id: strict-origin-fixture',
        `      name: ${fixture}`,
        '      inject: [webServer]',
        '',
      ].join('\n'),
    )
    await initialize(home)
    mock = createHttpServer(async (req, res) => {
      for await (const _chunk of req) {
        // Consume the complete model request without retaining prompt or credentials.
      }
      modelRequests.push({ method: req.method ?? '', path: req.url ?? '' })
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', object: 'model' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const event = (type: string, data: unknown) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      event('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_proxy_test',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'deepseek-flash',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      })
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '代理链路' },
      })
      setTimeout(() => {
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '聊天成功' },
        })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 4 },
        })
        event('message_stop', { type: 'message_stop' })
        res.end()
      }, 400)
    })
    await new Promise<void>((resolve, reject) => {
      mock!.once('error', reject)
      mock!.listen(13103, '127.0.0.1', resolve)
    })
    server = spawn(dsh, ['web', '--no-open', '--port', String(dshPort)], {
      cwd: home,
      env: {
        ...testEnv(home),
        STRICT_PUBLIC_ORIGIN: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    relay = await startForwarder({ listenPort: relayPort, upstreamPort: dshPort })
    proxy = await startForwarder({
      listenPort: publicPort,
      upstreamPort: relayPort,
      tls: {
        key: await readFile(new URL('../fixtures/tls/auth-remote.test.key.pem', import.meta.url)),
        cert: await readFile(new URL('../fixtures/tls/auth-remote.test.cert.pem', import.meta.url)),
      },
    })
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error(`DSH exited: ${stderr.slice(0, 2000)}`)
      try {
        const response = await proxyRequest('/auth-remote/ready')
        if (response.status === 200 && JSON.parse(response.body).ready === true) {
          ready = true
          break
        }
      } catch {
        // Wait for the DSH listener and Connection.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(ready, true, `proxy chain never became ready: ${stderr.slice(0, 2000)}`)
    assert.equal((await proxyRequest('/', { accept: 'text/html' })).status, 302)
    assert.equal((await proxyRequest('/plugins/strict/echo', { origin })).status, 401)
    assert.equal((await proxyRequest('/plugins/public/echo', { origin })).status, 401)
    assert.equal(
      (await proxyRequest('/plugins/strict/echo', { method: 'POST', origin })).status,
      401,
    )
    const direct = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/plugins/strict/echo',
          method: 'POST',
          headers: { host: publicHost, origin },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(direct, 401, 'relay loopback address must not bypass authentication')
    assert.equal((await fetch(`${directOrigin}/auth-remote/ready`)).status, 200)
    const describeSettings = (cookie?: string) =>
      fetch(`${directOrigin}/api/settings/describe`, {
        method: 'POST',
        headers: {
          origin: directOrigin,
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'direct-settings-probe',
          method: 'settings/describe',
          payload: { args: {} },
        }),
      })
    assert.equal((await describeSettings()).status, 401)
    const directLogin = await fetch(`${directOrigin}/auth-remote/login`, {
      method: 'POST',
      headers: { origin: directOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(directLogin.status, 200)
    assert.equal((await directLogin.json()).kind, 'session')
    const directSetCookie = directLogin.headers.get('set-cookie')
    assert.ok(directSetCookie)
    assert.equal(directSetCookie.includes('; Secure'), false)
    const directCookie = directSetCookie.split(';')[0]!
    const directMe = await fetch(`${directOrigin}/auth-remote/me`, {
      headers: { cookie: directCookie },
    })
    assert.equal(directMe.status, 200)
    assert.equal(directMe.headers.get('set-cookie'), null)
    const directSettings = await describeSettings(directCookie)
    assert.equal(directSettings.status, 200)
    assert.equal((await directSettings.json()).result.ok, true)
    const directLogout = await fetch(`${directOrigin}/auth-remote/logout`, {
      method: 'POST',
      headers: { origin: directOrigin, cookie: directCookie },
    })
    assert.equal(directLogout.status, 200)
    assert.equal(directLogout.headers.get('set-cookie')?.includes('; Secure'), false)
    assert.equal((await describeSettings(directCookie)).status, 401)

    browser = await launchBrowser([
      '--no-proxy-server',
      '--host-resolver-rules=MAP auth-remote.test 127.0.0.1',
    ])
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN' })
    await context.addInitScript(() => {
      try {
        localStorage.setItem('dsh-auth-remote.locale', 'zh')
      } catch {
        /* opaque origins */
      }
    })
    const page = await context.newPage()
    const apiFailures: { path: string; status: number }[] = []
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/api/') && response.status() >= 400)
        apiFailures.push({ path, status: response.status() })
    })
    await page.goto(`${origin}/`)
    await page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    await page.getByLabel('用户名').fill('alice')
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '继续' }).click()
    await page.getByRole('button', { name: '跳过，进入 DSH' }).click()
    await page.waitForSelector('[class*="frame"]')
    const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
    await notice.waitFor()
    await notice.getByRole('button', { name: '继续' }).click()
    await notice.waitFor({ state: 'hidden' })
    await completeApiKeyPrompt(page, 5000)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    const modelTab = settings.getByRole('button', { name: '模型', exact: true })
    try {
      await modelTab.click({ timeout: 5000 })
    } catch (error) {
      if (!(await completeApiKeyPrompt(page))) throw error
      await modelTab.click()
    }
    // Some DSH versions open an unconfigured provider directly in edit mode.
    const edit = settings.getByRole('button', { name: /编辑/u })
    const customized = settings.getByText('自定义设置', { exact: true })
    await edit.or(customized).first().waitFor()
    if (!(await customized.isVisible())) await edit.click()
    await settings.getByText('自定义设置', { exact: true }).click()
    await settings.getByLabel('API 地址').fill('http://127.0.0.1:13103/anthropic')
    const modelApiKey = settings.getByRole('textbox', { name: 'API 密钥' })
    if (await modelApiKey.count()) await modelApiKey.fill('proxy-test-key')
    const modelMutate = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/mutate',
    )
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    assert.equal((await modelMutate).status(), 200)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '选择工作区' }).click()
    const directory = page.getByRole('dialog', { name: '选择工作区目录' })
    await directory.getByText('workspace', { exact: true }).click()
    await directory.getByRole('button', { name: '打开' }).click()
    await directory.waitFor({ state: 'hidden' })
    const composer = page.getByRole('textbox', {
      name: '描述你想要构建的内容, / 调用指令, @ 文件或对话',
    })
    await composer.fill('请回复代理链路聊天成功')
    await composer.press('Enter')
    await page
      .getByText('代理链路', { exact: true })
      .waitFor({ timeout: 15000 })
      .catch(async (error) => {
        throw new Error(
          `chat did not stream: ${String(error)}; body=${(await page.locator('body').innerText()).slice(-2500)}; mock=${JSON.stringify(modelRequests)}`,
        )
      })
    // DSH rc.2 shortened the completed-turn announcement from 已完成工作 to 已完成.
    const completedTurn = page.getByRole('status').filter({ hasText: /^已完成(?:工作)?$/u })
    await completedTurn.waitFor({ timeout: 15000 })
    await page.getByText('代理链路聊天成功', { exact: true }).last().waitFor()
    assert.ok(modelRequests.some((request) => request.method === 'POST'))
    assert.ok(modelRequests.every((request) => request.path === '/anthropic/v1/messages'))
    const uploaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/session/uploadFileBinary',
    )
    await page.locator('input[type=file]').setInputFiles({
      name: 'proxy-upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(64 * 1024, 0x61),
    })
    assert.equal((await uploaded).status(), 200)
    await page.getByText('proxy-upload.txt').waitFor()
    await page.getByRole('button', { name: '打开右侧边栏' }).click()
    await page.getByText('工作区文件', { exact: true }).click()
    await page.getByText('proxy-note.md', { exact: true }).waitFor()
    await page.getByText('proxy-note.md', { exact: true }).click()
    await page.getByText('来自官方预览。').waitFor()
    await page.reload()
    await completedTurn.waitFor()
    const cookies = await context.cookies()
    assert.deepEqual(
      cookies.map((cookie) => cookie.name),
      ['dsh_auth_remote'],
    )
    assert.equal(cookies[0]?.secure, true)
    const pluginCookie = `dsh_auth_remote=${cookies[0]!.value}`

    const authenticatedGet = await proxyRequest('/plugins/strict/echo', {
      origin,
      cookie: pluginCookie,
    })
    assert.equal(authenticatedGet.status, 200, authenticatedGet.body)
    assert.equal(JSON.parse(authenticatedGet.body).hasNative, true)
    assert.equal(JSON.parse(authenticatedGet.body).hasPlugin, false)

    const bytes = Buffer.alloc(128 * 1024, 0x61)
    const upload = await proxyRequest('/plugins/strict/echo', {
      method: 'POST',
      origin,
      cookie: pluginCookie,
      body: bytes,
    })
    assert.equal(upload.status, 200, upload.body)
    const normalized = JSON.parse(upload.body)
    assert.equal(normalized.host, `127.0.0.1:${dshPort}`)
    assert.equal(normalized.origin, `http://127.0.0.1:${dshPort}`)
    assert.equal(normalized.bytes, bytes.length)
    assert.equal(normalized.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(normalized.hasNative, true)
    assert.equal(normalized.hasPlugin, false)
    const preserved = await proxyRequest('/plugins/public/echo', {
      method: 'POST',
      origin,
      cookie: pluginCookie,
      body: Buffer.from('public'),
    })
    assert.equal(preserved.status, 200, preserved.body)
    assert.equal(JSON.parse(preserved.body).host, publicHost)
    assert.equal(JSON.parse(preserved.body).origin, origin)
    assert.equal(JSON.parse(preserved.body).hasNative, true)
    assert.equal(
      (
        await proxyRequest('/plugins/strict/echo', {
          method: 'POST',
          origin: 'https://evil.test',
          cookie: pluginCookie,
        })
      ).status,
      403,
    )
    assert.equal(
      (await proxyRequest('/plugins/strict/echo', { method: 'POST', cookie: pluginCookie })).status,
      403,
    )

    const socketResult = await page.evaluate(
      (address) =>
        new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(address)
          const timeout = setTimeout(() => reject(new Error('WebSocket did not open')), 5000)
          socket.onmessage = (event) => {
            clearTimeout(timeout)
            resolve(String(event.data))
            socket.close()
          }
          socket.onerror = () => reject(new Error('WebSocket failed'))
        }),
      `wss://${publicHost}/plugins/strict/socket`,
    )
    assert.equal(socketResult, 'strict-ready')

    server.kill('SIGTERM')
    await once(server, 'exit')
    server = spawn(dsh, ['web', '--no-open', '--port', String(dshPort)], {
      cwd: home,
      env: {
        ...testEnv(home),
        STRICT_PUBLIC_ORIGIN: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stderr = ''
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error(`DSH restart exited: ${stderr.slice(0, 2000)}`)
      try {
        if ((await proxyRequest('/auth-remote/ready')).status === 200) {
          ready = true
          break
        }
      } catch {
        // Socket and Connection are coming back through the forwarders.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(ready, true, `DSH restart never became ready: ${stderr.slice(0, 2000)}`)
    assert.equal((await proxyRequest('/auth-remote/me', { cookie: pluginCookie })).status, 200)
    await page.reload()
    await completedTurn.waitFor()

    const retainedSocketMessage = await page.evaluate(
      (address) =>
        new Promise<string>((resolve, reject) => {
          const state = window as typeof window & { __testSocketClosed?: boolean }
          state.__testSocketClosed = false
          const socket = new WebSocket(address)
          const timeout = setTimeout(
            () => reject(new Error('retained WebSocket did not open')),
            5000,
          )
          socket.onmessage = (event) => {
            clearTimeout(timeout)
            resolve(String(event.data))
          }
          socket.onclose = () => {
            state.__testSocketClosed = true
          }
          socket.onerror = () => reject(new Error('retained WebSocket failed'))
        }),
      `wss://${publicHost}/plugins/strict/socket`,
    )
    assert.equal(retainedSocketMessage, 'strict-ready')

    const stream = await new Promise<{ closed: Promise<void> }>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port: publicPort,
          path: '/plugins/strict/stream',
          rejectUnauthorized: false,
          headers: { host: publicHost, origin, cookie: pluginCookie },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`stream status ${res.statusCode}`))
            return
          }
          res.once('data', (chunk: Buffer) => {
            if (!chunk.toString('utf8').includes('ready'))
              reject(new Error('stream had no ready event'))
            else resolve({ closed: new Promise<void>((done) => res.once('close', done)) })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    const logout = await proxyRequest('/auth-remote/logout', {
      method: 'POST',
      origin,
      cookie: pluginCookie,
    })
    assert.equal(logout.status, 200)
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        stream.closed,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('stream stayed open after logout')), 5000)
        }),
      ])
    } finally {
      clearTimeout(closeTimer)
    }
    await page.waitForFunction(
      () =>
        (window as typeof window & { __testSocketClosed?: boolean }).__testSocketClosed === true,
      undefined,
      { timeout: 5000 },
    )
    assert.equal(
      (await proxyRequest('/plugins/strict/echo', { method: 'POST', origin, cookie: pluginCookie }))
        .status,
      401,
    )
    const freshLogin = await proxyRequest('/auth-remote/login', {
      method: 'POST',
      origin,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ username: 'alice', password })),
    })
    assert.equal(freshLogin.status, 200, freshLogin.body)
    assert.equal(JSON.parse(freshLogin.body).kind, 'session')
    const policyCookie = (freshLogin.headers['set-cookie'] as string[])[0]!.split(';')[0]!
    const patchPath = join(profile, 'cordis.patch.yml')
    const tightened = (await readFile(patchPath, 'utf8')).replace(
      'requireTotp: false',
      'requireTotp: true',
    )
    await writeFile(patchPath, tightened)
    server.kill('SIGTERM')
    await once(server, 'exit')
    server = spawn(dsh, ['web', '--no-open', '--port', String(dshPort)], {
      cwd: home,
      env: {
        ...testEnv(home),
        STRICT_PUBLIC_ORIGIN: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stderr = ''
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null)
        throw new Error(`tightened DSH exited: ${stderr.slice(0, 2000)}`)
      try {
        if ((await proxyRequest('/auth-remote/ready')).status === 200) {
          ready = true
          break
        }
      } catch {
        // Reapply policy before admission resumes.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(ready, true)
    assert.equal((await proxyRequest('/auth-remote/me', { cookie: policyCookie })).status, 401)
    const bindingLogin = await proxyRequest('/auth-remote/login', {
      method: 'POST',
      origin,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ username: 'alice', password })),
    })
    assert.equal(bindingLogin.status, 200)
    assert.equal(JSON.parse(bindingLogin.body).kind, 'binding')
    assert.equal(bindingLogin.headers['set-cookie'], undefined)
  } finally {
    await browser?.close()
    await new Promise<void>((resolve) => mock?.close(() => resolve()) ?? resolve())
    await proxy?.close()
    await relay?.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'exit').catch(() => {})
    }
    await rm(home, { recursive: true, force: true })
  }
})
