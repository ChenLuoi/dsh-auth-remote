import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { AuthService } from '../../src/auth/service.js'
import { totpCode } from '../../src/auth/totp.js'
import { AdminUnavailable, requestAdmin } from '../../src/cli/ipc-client.js'
import { resolveProfileTarget } from '../../src/cli/profile.js'
import { AdminSocket } from '../../src/http/admin-socket.js'
import { AuthRemoteWebServer } from '../../src/index.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { archive, dsh, packageName, project } from '../helpers/runtime.js'

const cli = join(project, 'dist/cli.js')
const packageVersion = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  .version as string
const password = 'test secure password 123'
const replacement = 'replacement password 456'

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  home: string,
  localeEnv: NodeJS.ProcessEnv = {},
): Promise<Result> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...localeEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'close')) as [number | null]
  return { code, stdout, stderr }
}

test('CLI language precedence, option positions, help, version and JSON remain stable', async () => {
  const f = await profileFixture()
  try {
    const zh = await run(process.execPath, [cli, '--help'], f.profile, f.home, {
      LC_ALL: 'zh_CN.UTF-8',
      LC_MESSAGES: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    })
    assert.equal(zh.code, 0, zh.stderr)
    assert.match(zh.stdout, /用法：/u)
    const messages = await run(process.execPath, [cli, 'status'], f.profile, f.home, {
      LC_ALL: '',
      LC_MESSAGES: 'zh-Hans',
      LANG: 'en_US.UTF-8',
    })
    assert.equal(messages.code, 0, messages.stderr)
    assert.match(messages.stdout, /账号: 未初始化/u)
    const english = await run(process.execPath, [cli, '--lang=en', '--help'], f.profile, f.home, {
      LC_ALL: 'zh_CN.UTF-8',
      LC_MESSAGES: 'zh_CN.UTF-8',
      LANG: 'zh_CN.UTF-8',
    })
    assert.equal(english.code, 0, english.stderr)
    assert.match(english.stdout, /Usage:/u)
    const fallback = await run(process.execPath, [cli, '--help'], f.profile, f.home, {
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: 'fr_FR.UTF-8',
    })
    assert.match(fallback.stdout, /Usage:/u)
    const version = await run(
      process.execPath,
      [cli, '--version', '--lang', 'zh'],
      f.profile,
      f.home,
    )
    assert.equal(version.code, 0, version.stderr)
    assert.equal(version.stdout, `${packageVersion}\n`)
    const jsonZh = await run(
      process.execPath,
      [cli, 'status', '--json', '--lang', 'zh'],
      f.profile,
      f.home,
    )
    const jsonEn = await run(
      process.execPath,
      [cli, '--lang=en', 'status', '--json'],
      f.profile,
      f.home,
    )
    assert.equal(jsonZh.code, 0, jsonZh.stderr)
    assert.equal(jsonEn.code, 0, jsonEn.stderr)
    assert.deepEqual(JSON.parse(jsonZh.stdout), JSON.parse(jsonEn.stdout))
    const wrongProfile = await run(process.execPath, [cli, 'status', '--lang=zh'], f.home, f.home)
    assert.notEqual(wrongProfile.code, 0)
    assert.match(wrongProfile.stderr, /当前目录不是 DSH_HOME/u)
    for (const [args, message] of [
      [['--lang', 'zh', '--lang=en', 'status'], /--lang 只能指定一次/u],
      [['--lang', '--help'], /Missing value for --lang/u],
      [['status', '--lang=fr'], /Invalid --lang value/u],
      [['status', '--unknown', '--lang=zh'], /命令或参数无效/u],
    ] as const) {
      const result = await run(process.execPath, [cli, ...args], f.profile, f.home)
      assert.notEqual(result.code, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, message)
    }
  } finally {
    await f.cleanup()
  }
})

test('English interactive initialization hides secrets and localizes human status', async () => {
  const f = await profileFixture()
  try {
    const shortPassword = await pty(
      [process.execPath, cli, 'init'],
      [
        ['Username: ', 'alice'],
        ['Password: ', 'too short'],
        ['Enter password again: ', 'too short'],
      ],
      f.profile,
      f.home,
      'en',
    )
    assert.notEqual(shortPassword.code, 0)
    assert.match(shortPassword.stdout + shortPassword.stderr, /Password must contain 12–256/u)
    assert.equal(shortPassword.stdout.includes('too short'), false)
    const initialized = await pty(
      [process.execPath, cli, 'init'],
      [
        ['Username: ', 'alice'],
        ['Password: ', password],
        ['Enter password again: ', password],
      ],
      f.profile,
      f.home,
      'en',
    )
    assert.equal(initialized.code, 0, initialized.stderr + initialized.stdout)
    assert.match(initialized.stdout, /init completed/u)
    assert.equal(initialized.stdout.includes(password), false)
    const status = await run(process.execPath, [cli, 'status', '--lang=en'], f.profile, f.home)
    assert.equal(status.code, 0, status.stderr)
    assert.match(status.stdout, /Account: Initialized/u)
    assert.match(status.stdout, /Service: Offline/u)
  } finally {
    await f.cleanup()
  }
})

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function pty(
  command: string[],
  prompts: readonly [string, string][],
  cwd: string,
  home: string,
  language: 'en' | 'zh' = 'zh',
): Promise<Result> {
  const child = spawn(
    'script',
    ['-q', '-e', '-f', '-c', [...command, '--lang', language].map(quote).join(' '), '/dev/null'],
    {
      cwd,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let index = 0
  let cursor = 0
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    while (index < prompts.length) {
      const [label, answer] = prompts[index]!
      const found = stdout.indexOf(label, cursor)
      if (found < 0) break
      cursor = found + label.length
      index++
      child.stdin.write(`${answer}\n`)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'close')) as [number | null]
  clearTimeout(timer)
  return { code, stdout, stderr }
}

async function profileFixture() {
  const home = await mkdtemp(join(tmpdir(), 'auth-remote-cli-'))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{"name":"test-profile","private":true}\n')
  return { home, profile, cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('profile target matches DSH_HOME and rejects a wrong working directory', async () => {
  const f = await profileFixture()
  try {
    const target = await resolveProfileTarget(f.profile, { DSH_HOME: f.home })
    assert.equal(target.name, 'web')
    assert.equal(target.dir, f.profile)
    await assert.rejects(
      resolveProfileTarget(f.home, { DSH_HOME: f.home }),
      /not the selected DSH profile/u,
    )
    const other = await mkdtemp(join(tmpdir(), 'auth-remote-wrong-home-'))
    try {
      await mkdir(join(other, 'profiles'), { recursive: true })
      await assert.rejects(
        resolveProfileTarget(f.profile, { DSH_HOME: other }),
        /not the selected DSH profile/u,
      )
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  } finally {
    await f.cleanup()
  }
})

test('Unix socket enforces private modes, online ack and offline lock exclusion', async () => {
  const f = await profileFixture()
  const store = await AuthStateStore.open(f.profile)
  const auth = new AuthService(store, { requireTotp: false, sessionHours: 1 })
  const admin = new AdminSocket(
    f.profile,
    auth,
    () => true,
    () => {},
  )
  try {
    await admin.start()
    assert.equal((await stat(admin.path)).mode & 0o777, 0o600)
    const online = await run(process.execPath, [cli, 'status', '--json'], f.profile, f.home)
    assert.equal(online.code, 0, online.stderr)
    assert.equal(JSON.parse(online.stdout).online, true)
    await assert.rejects(
      requestAdmin(admin.path, {
        version: 1,
        command: 'init',
        username: 'alice',
        password: 'short',
      }),
      /invalid_input/u,
    )
    assert.equal(auth.status().initialized, false)
    await requestAdmin(admin.path, { version: 1, command: 'init', username: 'alice', password })
    await assert.rejects(
      requestAdmin(admin.path, { version: 1, command: 'init', username: 'alice', password }),
      /already_initialized/u,
    )
    const revision = store.current().revision
    for (const invalidPassword of ['short', 'x'.repeat(257)]) {
      await assert.rejects(
        requestAdmin(admin.path, {
          version: 1,
          command: 'reset-password',
          password: invalidPassword,
        }),
        /invalid_input/u,
      )
      assert.equal(store.current().revision, revision)
    }
    const issued = await auth.login('alice', password)
    if (issued.kind !== 'session') throw new Error('session required')
    await requestAdmin(admin.path, { version: 1, command: 'revoke-sessions' })
    assert.equal(auth.session(issued.token), null)
    await chmod(admin.path, 0o644)
    await assert.rejects(
      requestAdmin(admin.path, { version: 1, command: 'status' }),
      /unsafe management socket/u,
    )
    await chmod(admin.path, 0o600)
    await chmod(join(f.profile, 'auth-remote'), 0o755)
    await assert.rejects(
      requestAdmin(admin.path, { version: 1, command: 'status' }),
      /unsafe management directory/u,
    )
    await chmod(join(f.profile, 'auth-remote'), 0o700)
    await admin.dispose()
    await assert.rejects(
      requestAdmin(admin.path, { version: 1, command: 'status' }),
      AdminUnavailable,
    )
    const blocked = await run(process.execPath, [cli, 'status', '--json'], f.profile, f.home)
    assert.notEqual(blocked.code, 0)
    assert.match(blocked.stderr, /service holds the profile lock/u)
  } finally {
    await admin.dispose()
    auth.dispose()
    await store.close()
    const offline = await run(process.execPath, [cli, 'status', '--json'], f.profile, f.home)
    assert.equal(offline.code, 0, offline.stderr)
    assert.equal(JSON.parse(offline.stdout).online, false)
    await f.cleanup()
  }
})

test('connected socket failure is uncertain and never falls back to an offline write', async () => {
  const f = await profileFixture()
  const dir = join(f.profile, 'auth-remote')
  const path = join(dir, 'admin.sock')
  await mkdir(dir, { mode: 0o700 })
  const server = createServer((socket) => {
    socket.once('data', () => socket.destroy())
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o600)
    const result = await run(process.execPath, [cli, 'status', '--json'], f.profile, f.home)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /result is unknown/u)
    await assert.rejects(readFile(join(dir, 'auth-state.json'), 'utf8'), /ENOENT/u)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await f.cleanup()
  }
})

test('service refuses a non-socket management path without deleting it', async () => {
  const f = await profileFixture()
  const store = await AuthStateStore.open(f.profile)
  const auth = new AuthService(store, { requireTotp: false, sessionHours: 1 })
  const path = join(f.profile, 'auth-remote', 'admin.sock')
  try {
    await writeFile(path, 'unexpected', { mode: 0o600 })
    const admin = new AdminSocket(
      f.profile,
      auth,
      () => true,
      () => {},
    )
    await assert.rejects(admin.start(), /unsafe admin socket path/u)
    assert.equal(await readFile(path, 'utf8'), 'unexpected')
    await assert.rejects(
      requestAdmin(path, { version: 1, command: 'status' }),
      /unsafe management socket/u,
    )
  } finally {
    auth.dispose()
    await store.close()
    await f.cleanup()
  }
})

test('a committed mutation with a lost acknowledgement is reported as uncertain', async () => {
  const f = await profileFixture()
  const store = await AuthStateStore.open(f.profile)
  const auth = new AuthService(store, { requireTotp: false, sessionHours: 1 })
  await auth.initialize('alice', password)
  const issued = await auth.login('alice', password)
  if (issued.kind !== 'session') throw new Error('session required')
  const path = join(f.profile, 'auth-remote', 'admin.sock')
  const server = createServer((socket) => {
    socket.once('data', () => {
      void auth.revokeAll().then(
        () => socket.destroy(),
        () => socket.destroy(),
      )
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o600)
    const result = await pty(
      [process.execPath, cli, 'revoke-sessions'],
      [['输入 web 以确认 revoke-sessions: ', 'web']],
      f.profile,
      f.home,
    )
    assert.notEqual(result.code, 0)
    assert.match(result.stdout + result.stderr, /结果未知/u)
    assert.equal((result.stdout + result.stderr).includes('已完成；变更已持久化'), false)
    assert.equal(auth.session(issued.token), null)
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')).sessions, {})
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    auth.dispose()
    await store.close()
    await f.cleanup()
  }
})

test('installed DSH profile exec supports hidden interactive CLI and live management', async () => {
  const home = await mkdtemp(join(tmpdir(), 'auth-remote-dsh-cli-'))
  const profile = join(home, 'profiles', 'web')
  try {
    const installed = await run(dsh, ['plugin', '--profile', 'web', 'add', archive], home, home)
    assert.equal(installed.code, 0, installed.stderr)
    const empty = await run(
      dsh,
      ['plugin', '--profile', 'web', 'exec', packageName, 'status', '--json'],
      home,
      home,
    )
    assert.equal(empty.code, 0, empty.stderr)
    assert.equal(JSON.parse(empty.stdout).initialized, false)
    const noTty = await run(
      dsh,
      ['plugin', '--profile', 'web', 'exec', packageName, 'init'],
      home,
      home,
    )
    assert.notEqual(noTty.code, 0)
    assert.match(noTty.stderr, /interactive terminal is required/u)
    const mismatch = await pty(
      [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'init'],
      [
        ['用户名: ', 'alice'],
        ['密码: ', password],
        ['再次输入密码: ', replacement],
      ],
      home,
      home,
    )
    assert.notEqual(mismatch.code, 0)
    assert.match(mismatch.stdout + mismatch.stderr, /两次输入的密码不一致/u)
    const afterMismatch = await run(
      dsh,
      ['plugin', '--profile', 'web', 'exec', packageName, 'status', '--json'],
      home,
      home,
    )
    assert.equal(afterMismatch.code, 0, afterMismatch.stderr)
    assert.equal(JSON.parse(afterMismatch.stdout).initialized, false)
    const initialized = await pty(
      [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'init'],
      [
        ['用户名: ', 'alice'],
        ['密码: ', password],
        ['再次输入密码: ', password],
      ],
      home,
      home,
    )
    assert.equal(initialized.code, 0, initialized.stderr + initialized.stdout)
    assert.equal(initialized.stdout.includes(password), false)
    const statePath = join(profile, 'auth-remote', 'auth-state.json')
    assert.equal((await stat(statePath)).mode & 0o777, 0o600)
    const saved = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(saved.account.username, 'alice')
    assert.equal(JSON.stringify(saved).includes(password), false)
    const repeated = await pty(
      [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'init'],
      [
        ['用户名: ', 'alice'],
        ['密码: ', replacement],
        ['再次输入密码: ', replacement],
      ],
      home,
      home,
    )
    assert.notEqual(repeated.code, 0)
    assert.match(repeated.stdout + repeated.stderr, /账号已初始化/u)
    assert.equal(repeated.stdout.includes(replacement), false)
    const store = await AuthStateStore.open(profile)
    const auth = new AuthService(store, { requireTotp: false, sessionHours: 1 })
    const admin = new AdminSocket(
      profile,
      auth,
      () => true,
      () => {},
    )
    try {
      await admin.start()
      const issued = await auth.login('alice', password)
      if (issued.kind !== 'session') throw new Error('session required')
      const online = await run(
        dsh,
        ['plugin', '--profile', 'web', 'exec', packageName, 'status', '--json'],
        home,
        home,
      )
      assert.equal(online.code, 0, online.stderr)
      assert.equal(JSON.parse(online.stdout).online, true)
      const wrongConfirmation = await pty(
        [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'revoke-sessions'],
        [['输入 web 以确认 revoke-sessions: ', 'other']],
        home,
        home,
      )
      assert.notEqual(wrongConfirmation.code, 0)
      assert.ok(auth.session(issued.token))
      const revoked = await pty(
        [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'revoke-sessions'],
        [['输入 web 以确认 revoke-sessions: ', 'web']],
        home,
        home,
      )
      assert.equal(revoked.code, 0, revoked.stderr + revoked.stdout)
      assert.equal(auth.session(issued.token), null)
      const next = await auth.login('alice', password)
      if (next.kind !== 'session') throw new Error('session required')
      const binding = await auth.startBinding(next.token, password)
      const bound = await auth.confirmBinding(
        binding.challenge,
        totpCode(binding.secret, Math.floor(Date.now() / 30_000)),
      )
      assert.equal(auth.status().totpEnabled, true)
      const pendingMfa = await auth.login('alice', password)
      if (pendingMfa.kind !== 'mfa') throw new Error('MFA challenge required')
      const boundSession = await auth.verifyMfa(pendingMfa.challenge, bound.backupCodes[0]!)
      assert.ok(auth.session(boundSession.token))
      const resetTotp = await pty(
        [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'reset-totp'],
        [['输入 web 以确认 reset-totp: ', 'web']],
        home,
        home,
      )
      assert.equal(resetTotp.code, 0, resetTotp.stderr + resetTotp.stdout)
      assert.equal(auth.status().totpEnabled, false)
      assert.equal(auth.session(boundSession.token), null)
    } finally {
      await admin.dispose()
      auth.dispose()
      await store.close()
    }
    const reset = await pty(
      [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'reset-password'],
      [
        ['输入 web 以确认 reset-password: ', 'web'],
        ['新密码: ', replacement],
        ['再次输入新密码: ', replacement],
      ],
      home,
      home,
    )
    assert.equal(reset.code, 0, reset.stderr + reset.stdout)
    assert.equal(reset.stdout.includes(replacement), false)
    const verifiedStore = await AuthStateStore.open(profile)
    const verifiedAuth = new AuthService(verifiedStore, { requireTotp: false, sessionHours: 1 })
    try {
      await assert.rejects(verifiedAuth.login('alice', password), /invalid_credentials/u)
      assert.equal((await verifiedAuth.login('alice', replacement)).kind, 'session')
    } finally {
      verifiedAuth.dispose()
      await verifiedStore.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('online profile exec acknowledges reset only after persistent revoke and SSE disconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'auth-remote-cli-live-'))
  const profile = join(home, 'profiles', 'web')
  const origin = 'http://auth-remote.test:13090'
  const host = 'auth-remote.test:13090'
  const ctx = new Context()
  try {
    const installed = await run(dsh, ['plugin', '--profile', 'web', 'add', archive], home, home)
    assert.equal(installed.code, 0, installed.stderr)
    const store = await AuthStateStore.open(profile)
    const setup = new AuthService(store, { requireTotp: false, sessionHours: 1 })
    await setup.initialize('alice', password)
    setup.dispose()
    await store.close()
    ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
    ctx.provide('webStartup', { host: '127.0.0.1', port: 0 } as never)
    let record: unknown
    ctx.provide('credentials', {
      readRecord: async () => record,
      modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
        record = (await mutate(record)) ?? record
        return record
      },
      deleteRecord: async () => {
        record = undefined
      },
    } as never)
    await ctx.plugin(AuthRemoteWebServer, {
      allowedOrigins: [origin],
      requireTotp: false,
    })
    await ctx.plugin(Connection, { trustedHosts: [host] })
    await ctx.fiber.await()
    const server = ctx.webServer as AuthRemoteWebServer
    server.register({
      kind: 'exact',
      path: '/events',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: connected\n\n')
      },
    })
    async function openStream(token: string): Promise<{ closed: Promise<void> }> {
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: server.port,
            path: '/events',
            headers: { host, origin, cookie: `dsh_auth_remote=${token}` },
          },
          resolve,
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(response.statusCode, 200)
      response.on('error', () => undefined)
      return {
        closed: new Promise<void>((resolve) => {
          response.once('close', resolve)
        }),
      }
    }
    const first = await server.authentication.login('alice', password)
    if (first.kind !== 'session') throw new Error('session required')
    const stream = await openStream(first.token)
    const revoked = await pty(
      [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'revoke-sessions'],
      [['输入 web 以确认 revoke-sessions: ', 'web']],
      home,
      home,
    )
    assert.equal(revoked.code, 0, revoked.stderr + revoked.stdout)
    await stream.closed
    assert.equal(server.authentication.session(first.token), null)
    const persisted = JSON.parse(
      await readFile(join(profile, 'auth-remote', 'auth-state.json'), 'utf8'),
    )
    assert.deepEqual(persisted.sessions, {})
    const second = await server.authentication.login('alice', password)
    if (second.kind !== 'session') throw new Error('session required')
    const secondStream = await openStream(second.token)
    const reset = await pty(
      [dsh, 'plugin', '--profile', 'web', 'exec', packageName, 'reset-password'],
      [
        ['输入 web 以确认 reset-password: ', 'web'],
        ['新密码: ', replacement],
        ['再次输入新密码: ', replacement],
      ],
      home,
      home,
    )
    assert.equal(reset.code, 0, reset.stderr + reset.stdout)
    assert.equal(reset.stdout.includes(replacement), false)
    await secondStream.closed
    assert.equal(server.authentication.session(second.token), null)
    await assert.rejects(server.authentication.login('alice', password), /invalid_credentials/u)
    assert.equal((await server.authentication.login('alice', replacement)).kind, 'session')
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
