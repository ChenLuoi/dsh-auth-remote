import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const archive = process.argv[2]
assert(archive, 'Usage: node scripts/check-npm-publication.mjs ARCHIVE')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`,
  { headers: { Accept: 'application/json' } },
)
if (response.status === 404) {
  console.log('unpublished')
  process.exit(0)
}
assert(response.ok, `npm registry returned HTTP ${response.status}`)
const published = await response.json()
assert.equal(published.name, manifest.name)
assert.equal(published.version, manifest.version)
const localIntegrity = `sha512-${createHash('sha512')
  .update(await readFile(archive))
  .digest('base64')}`
assert.equal(
  published.dist?.integrity,
  localIntegrity,
  `npm already has ${manifest.name}@${manifest.version} with different archive bytes`,
)
console.log('published')
