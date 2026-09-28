import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import vm from 'node:vm'
import semver from 'semver'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(manifest.name, 'dsh-auth-remote')
assert.equal(semver.valid(manifest.version), manifest.version)
assert.equal(Object.hasOwn(manifest, 'private'), false)
assert.equal(manifest.license, 'MIT')
assert.deepEqual(manifest.repository, {
  type: 'git',
  url: 'git+https://github.com/ChenLuoi/dsh-auth-remote.git',
})
assert.equal(manifest.homepage, 'https://github.com/ChenLuoi/dsh-auth-remote#readme')
assert.deepEqual(manifest.bugs, {
  url: 'https://github.com/ChenLuoi/dsh-auth-remote/issues',
})
assert.deepEqual(manifest.publishConfig, {
  access: 'public',
  registry: 'https://registry.npmjs.org/',
})
assert.deepEqual(manifest.files, [
  'dist',
  'cordis.patch.yml',
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh-CN.md',
  'LICENSE',
  'CHANGELOG.md',
  'CHANGELOG.zh-CN.md',
  'docs',
  'examples',
])
for (const entry of manifest.files) {
  assert.match(entry, /^[A-Za-z][A-Za-z0-9._/-]*$/u, `package file path must be relative: ${entry}`)
  await access(entry)
}
for (const file of [
  manifest.main,
  manifest.types,
  manifest.exports['./client'],
  manifest.bin[manifest.name],
  manifest.dsh.bundle.patch,
  'dist/login.js',
  'dist/login.css',
]) {
  await access(file)
}

let registration
vm.runInNewContext(await readFile('dist/client.js', 'utf8'), {
  window: {
    __ModuleLoader__: {
      load(value) {
        assert.equal(registration, undefined, 'client bundle must register exactly one factory')
        registration = value
      },
    },
  },
})
assert.equal(registration?.id, manifest.name)
assert.equal(typeof registration?.factory, 'function')

const metadata = JSON.parse(await readFile('.cache/build-meta.json', 'utf8'))
assert.equal(metadata.length, 3)
const requiredSources = [
  ['src/index.ts', 'src/cli/index.ts'],
  ['src/client/index.ts'],
  ['src/client/login/index.ts', 'src/client/login/style.css'],
]
for (const [index, build] of metadata.entries()) {
  for (const source of requiredSources[index]) {
    assert(Object.hasOwn(build.inputs, source), `entry ${index} must own ${source}`)
  }
  for (const file of Object.keys(build.inputs)) {
    assert(
      file.startsWith('src/') || file.startsWith('node_modules/'),
      `build input must belong to this source tree or declared dependencies: ${file}`,
    )
    if (index === 0)
      assert(!file.includes('node_modules/'), `dependency must remain external: ${file}`)
    else {
      assert(!/@deepseek-ai[/\\]/u.test(file), `DSH dependency bundled into browser: ${file}`)
      assert(
        !/node_modules[/\\]react(?:-dom)?[/\\]/u.test(file),
        `React bundled into browser: ${file}`,
      )
    }
  }
}
console.info(
  'Package entry points, login assets, lazy client factory and external host boundaries verified.',
)
