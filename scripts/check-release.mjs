import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import semver from 'semver'

assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--tag'))
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const version = manifest.version
assert.equal(semver.valid(version), version, 'package version must be valid SemVer')
assert.match(version, /^\d+\.\d+\.\d+$/u, 'release versions must use stable x.y.z numbers')

if (process.argv.length === 4)
  assert.equal(process.argv[3], `v${version}`, 'release tag must match package version')

for (const file of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']) {
  const content = await readFile(file, 'utf8')
  const headings = content.split('\n').filter((line) => line.startsWith(`## ${version} - `))
  assert.equal(headings.length, 1, `${file} needs exactly one dated ${version} entry`)
  assert.match(headings[0], /^## \d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}$/u)
  const section = content.split(headings[0])[1].split(/^## /mu)[0].trim()
  assert(section.length > 20, `${file} needs release notes for ${version}`)
}

console.info(`Release metadata verified for v${version}.`)
