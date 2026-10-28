import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  parseArguments,
  assertRegisteredCoverage,
  sha256,
  testCounts,
  unpackFiles,
  validateArchive,
} from '../../scripts/verify-packed.mjs'
import {
  assertVerificationRoot,
  createVerificationRoot,
  packageManifest,
  project,
  testedDshVersions,
} from '../../scripts/runtime.mjs'

async function fixture(manifest = packageManifest) {
  const directory = await mkdtemp(join(tmpdir(), 'packed-validation-'))
  const packageRoot = join(directory, 'package')
  await mkdir(join(packageRoot, 'dist/types'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
  for (const file of [
    'index.js',
    'cli.js',
    'client.js',
    'login.js',
    'login.css',
    'types/index.d.ts',
  ])
    await writeFile(join(packageRoot, 'dist', file), 'fixture')
  const archive = join(directory, 'candidate.tgz')
  const pack = async (extra: string[] = []) => {
    const result = spawnSync('tar', ['-czf', archive, ...extra, '-C', directory, 'package'], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return readFile(archive)
  }
  return {
    directory,
    packageRoot,
    pack,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('packed archive rejects a wrong digest, identity, missing assets and hostile tar paths before consumption', async () => {
  const f = await fixture()
  try {
    const accepted = await f.pack()
    assert.equal(
      validateArchive(accepted, sha256(accepted), '0.2.1-rc.2').manifest.name,
      packageManifest.name,
    )
    assert.throws(
      () => validateArchive(accepted, '0'.repeat(64), '0.2.1-rc.2'),
      /SHA-256 mismatch/u,
    )
    await writeFile(
      join(f.packageRoot, 'package.json'),
      JSON.stringify({ ...packageManifest, name: 'wrong-package' }),
    )
    const wrongBytes = await f.pack()
    assert.throws(
      () => validateArchive(wrongBytes, sha256(wrongBytes), '0.2.1-rc.2'),
      /Wrong archive package name/u,
    )
    await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify(packageManifest))
    await rm(join(f.packageRoot, 'dist/client.js'))
    const missing = await f.pack()
    assert.throws(
      () => validateArchive(missing, sha256(missing), '0.2.1-rc.2'),
      /Archive lacks dist\/client.js/u,
    )
    const escaping = await f.pack(['--transform=s,package,package/../../escape,'])
    assert.throws(() => unpackFiles(escaping), /canonical|Escaping/u)
    await symlink('/tmp', join(f.packageRoot, 'link'))
    const linkResult = spawnSync(
      'tar',
      ['-czf', join(f.directory, 'link.tgz'), '-C', f.directory, 'package/link'],
      { encoding: 'utf8' },
    )
    assert.equal(linkResult.status, 0, linkResult.stderr)
    const linkBytes = await readFile(join(f.directory, 'link.tgz'))
    assert.throws(() => unpackFiles(linkBytes), /Unsupported/u)
  } finally {
    await f.cleanup()
  }
})

test('suite and target selection fail closed, including actual Node zero-test output', async () => {
  const valid = [
    '--archive',
    '/tmp/candidate.tgz',
    '--sha256',
    'a'.repeat(64),
    '--dsh-version',
    '0.2.1-rc.2',
    '--suite',
    'cli',
  ]
  assert.deepEqual(parseArguments(valid).suites, ['cli'])
  assert.throws(() => parseArguments([...valid.slice(0, -1), 'unknown']), /Unknown suite/u)
  assert.throws(
    () => parseArguments([...valid.slice(0, -1), 'rc-bootstrap']),
    /no registered coverage/u,
  )
  assert.throws(
    () => parseArguments([...valid.slice(0, -1), 'theme', '--test-name-pattern', 'one']),
    /one cli or browser suite/u,
  )
  assert.throws(
    () => parseArguments(valid.map((value) => (value === '0.2.1-rc.2' ? '0.2.1-rc.5' : value))),
    /exact dsh-version/u,
  )
  const directory = await mkdtemp(join(tmpdir(), 'packed-empty-'))
  try {
    const file = join(directory, 'one.test.mjs')
    await writeFile(file, "import { test } from 'node:test'; test('one actual test', () => {});\n")
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const run = (pattern: string) =>
      spawnSync(
        process.execPath,
        ['--test', '--test-reporter=tap', '--test-name-pattern=' + pattern, file],
        { encoding: 'utf8', env },
      )
    const positive = run('one actual test')
    assert.equal(positive.status, 0, positive.stderr)
    assert.equal(testCounts(positive.stdout).tests, 1)
    const empty = run('^no such test$')
    assert.equal(empty.status, 0, empty.stderr)
    assert.throws(() => testCounts(empty.stdout, [file]), /zero tests/u)
    assert.throws(
      () => testCounts(positive.stdout.replace('# skipped 0', '# skipped 1')),
      /Unexpected skipped/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('verification roots require a real marked local directory and reject substituted roots', async () => {
  const root = await createVerificationRoot()
  try {
    await assertVerificationRoot(root)
    assert(
      Buffer.byteLength(join(root, 'h/profiles/web/auth-remote/admin.sock')) < 108,
      'verification management socket path exceeds Linux limit',
    )
    await assert.rejects(
      assertVerificationRoot('/tmp/arbitrary'),
      /Invalid packed verification root/u,
    )
    const ambient = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { ensureDevHome } from './scripts/dev-common.mjs'; await ensureDevHome()",
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DSH_VERIFY_ROOT: root, DSH_HOME: '/tmp/unowned-profile' },
      },
    )
    assert.notEqual(ambient.status, 0)
    assert.match(ambient.stderr, /Refusing ambient DSH_HOME/u)
    await assert.rejects(lstat(join(root, 'h')), { code: 'ENOENT' })
    const saved = root + '-saved'
    await rename(root, saved)
    try {
      await symlink(saved, root)
      await assert.rejects(assertVerificationRoot(root), /real local directory/u)
    } finally {
      await rm(root, { force: true })
      await rename(saved, root)
    }
    await writeFile(join(root, '.verify-root'), 'unowned')
    await assert.rejects(assertVerificationRoot(root), /Unmarked/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verification socket binds from a checkout as long as the default CI path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'packed-path-'))
  const ciCheckout = join('/', 'home', 'runner', 'work', 'dsh-auth-remote', 'dsh-auth-remote')
  const checkout = join(
    directory,
    'x'.repeat(Math.max(1, Buffer.byteLength(ciCheckout) - Buffer.byteLength(directory) - 1)),
  )
  try {
    await mkdir(join(checkout, 'scripts'), { recursive: true })
    await copyFile('package.json', join(checkout, 'package.json'))
    await copyFile('scripts/runtime.mjs', join(checkout, 'scripts/runtime.mjs'))
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict'
          import { mkdir, rm } from 'node:fs/promises'
          import { createConnection, createServer } from 'node:net'
          import { dirname, join } from 'node:path'
          import { createVerificationRoot } from './scripts/runtime.mjs'
          const root = await createVerificationRoot()
          const server = createServer(connection => connection.end('ready'))
          try {
            const socket = join(root, 'h/profiles/web/auth-remote/admin.sock')
            const bytes = Buffer.byteLength(socket)
            assert(bytes < 108, 'verification management socket path exceeds Linux limit')
            await mkdir(dirname(socket), { recursive: true })
            await new Promise((resolve, reject) => {
              server.once('error', reject)
              server.listen(socket, resolve)
            })
            const response = await new Promise((resolve, reject) => {
              const client = createConnection(socket)
              let data = ''
              client.setEncoding('utf8')
              client.on('data', chunk => { data += chunk })
              client.once('error', reject)
              client.once('end', () => resolve(data))
            })
            assert.equal(response, 'ready')
            console.log(JSON.stringify({ bytes, response }))
          } finally {
            if (server.listening) await new Promise(resolve => server.close(resolve))
            await rm(root, { recursive: true, force: true })
          }
        `,
      ],
      { cwd: checkout, encoding: 'utf8', env, timeout: 10_000 },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).response, 'ready')
    assert(JSON.parse(result.stdout).bytes < 108)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('complete browser coverage permits only exact zero-registration exceptions and preserves specialized counts', () => {
  for (const version of testedDshVersions) {
    for (const file of [
      'host-release',
      'web-search-settings',
      'rc-navigation',
      'account-login',
      'startup-compatibility',
      'native-transport',
      'unexpected',
    ]) {
      const counts = {
        actualTests: 1,
        placeholderFiles: [join(project, `tests/browser/${file}.spec.ts`)],
      }
      const allowed =
        file === 'host-release'
          ? version === '0.2.1-alpha.3'
          : file === 'web-search-settings'
            ? !['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4'].includes(version)
            : file === 'rc-navigation' && !['0.2.1-rc.3', '0.2.1-rc.4'].includes(version)
      if (allowed) assert.doesNotThrow(() => assertRegisteredCoverage('browser', version, counts))
      else
        assert.throws(
          () => assertRegisteredCoverage('browser', version, counts),
          /Required file registered zero tests/u,
        )
    }
  }
  assert.throws(
    () =>
      assertRegisteredCoverage('browser', '0.2.1-rc.5', { actualTests: 1, placeholderFiles: [] }),
    /Unknown coverage target/u,
  )
  assert.throws(
    () =>
      assertRegisteredCoverage('rc-bootstrap', '0.2.1-rc.1', {
        actualTests: 1,
        placeholderFiles: [],
      }),
    /specialized test count/u,
  )
  assert.throws(
    () =>
      assertRegisteredCoverage('account', '0.2.1-alpha.3', {
        actualTests: 1,
        placeholderFiles: [join(project, 'tests/browser/account-login.spec.ts')],
      }),
    /Required file registered zero tests/u,
  )
})
