import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const archive = `artifacts/${manifest.name}-${manifest.version}.tgz`
await mkdir('artifacts', { recursive: true })
const packed = spawnSync('pnpm', ['pack', '--pack-destination', 'artifacts'], {
  encoding: 'utf8',
})
if (packed.error) throw packed.error
if (packed.status !== 0)
  throw new Error(packed.stderr || packed.stdout || 'Package creation failed')

const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
if (listing.error) throw listing.error
if (listing.status !== 0) throw new Error(listing.stderr)
const files = new Set(listing.stdout.trim().split('\n'))
const fixedFiles = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/README.zh-CN.md',
  'package/docs/deployment.md',
  'package/docs/deployment.zh-CN.md',
  'package/docs/development.md',
  'package/docs/development.zh-CN.md',
  'package/docs/reverse-proxy.md',
  'package/docs/reverse-proxy.zh-CN.md',
  'package/examples/web-profile-auth-remote.patch.yml',
  'package/examples/traefik-dsh.yml',
  'package/examples/nginx.conf',
  'package/dist/index.js',
  'package/dist/cli.js',
  'package/dist/client.js',
  'package/dist/login.js',
  'package/dist/login.css',
  'package/dist/types/index.d.ts',
]
for (const file of fixedFiles) assert(files.has(file), `Missing packaged file: ${file}`)
for (const file of files) {
  if (fixedFiles.includes(file)) continue
  if (/^package\/dist\/(?:index|cli|client|login)\.js\.map$/u.test(file)) continue
  if (file === 'package/dist/login.css.map') continue
  if (/^package\/dist\/types\/[A-Za-z0-9/_-]+\.d\.ts(?:\.map)?$/u.test(file)) continue
  throw new Error(`Unexpected packaged file: ${file}`)
}

const checkRoot = resolve('.cache/package-check')
await rm(checkRoot, { recursive: true, force: true })
await mkdir(checkRoot, { recursive: true })
const extracted = spawnSync('tar', ['-xzf', archive, '-C', checkRoot], { encoding: 'utf8' })
if (extracted.error) throw extracted.error
assert.equal(extracted.status, 0, extracted.stderr)
const packageRoot = join(checkRoot, 'package')
const installedManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
assert.equal(installedManifest.name, manifest.name)
assert.equal(installedManifest.version, manifest.version)
assert.equal(Object.hasOwn(installedManifest, 'private'), false)
for (const file of [
  manifest.main,
  manifest.types,
  manifest.exports['./client'],
  manifest.bin[manifest.name],
]) {
  await access(join(packageRoot, file))
}
const docs = spawnSync(
  process.execPath,
  [join(import.meta.dirname, 'check-docs.mjs'), '--package-root', packageRoot],
  {
    encoding: 'utf8',
  },
)
if (docs.error) throw docs.error
assert.equal(docs.status, 0, docs.stderr)
process.stdout.write(docs.stdout)
console.info(`Local archive and bilingual package links verified: ${archive}`)
