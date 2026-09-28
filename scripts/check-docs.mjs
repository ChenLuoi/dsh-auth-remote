import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
assert(
  args.length === 0 || (args.length === 2 && args[0] === '--package-root'),
  'Usage: node scripts/check-docs.mjs [--package-root DIRECTORY]',
)
const root = args.length ? resolve(args[1]) : resolve(import.meta.dirname, '..')
const packaged = args.length > 0
const pairs = [
  ['README.md', 'README.zh-CN.md'],
  ['docs/deployment.md', 'docs/deployment.zh-CN.md'],
  ['docs/development.md', 'docs/development.zh-CN.md'],
  ['docs/reverse-proxy.md', 'docs/reverse-proxy.zh-CN.md'],
  ...(!packaged ? [['tests/README.md', 'tests/README.zh-CN.md']] : []),
]

const privateEnvironment =
  /(?:\/(?:home|Users)\/[^/\s`"']+|[A-Za-z]:\\Users\\[^\\\s]+|\b(?:10\.(?:\d{1,3}\.){2}|192\.168\.\d{1,3}\.|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.)\d{1,3}\b)/u

function checkPrivateEnvironment(file, content) {
  assert(
    !privateEnvironment.test(content),
    `${relative(root, file)} contains a machine-specific path or address`,
  )
}

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const sourceGroups = packaged
  ? []
  : await Promise.all(
      ['src', 'tests', 'scripts', 'docs', 'examples'].map((name) => sourceFiles(join(root, name))),
    )
const scanFiles = packaged
  ? await sourceFiles(root)
  : [
      ...sourceGroups.flat(),
      ...['README.md', 'README.zh-CN.md', 'package.json', 'cordis.patch.yml'].map((name) =>
        join(root, name),
      ),
    ]
for (const file of scanFiles) checkPrivateEnvironment(file, await readFile(file, 'utf8'))

for (const [english, chinese] of pairs) {
  const enPath = join(root, english)
  const zhPath = join(root, chinese)
  const en = await readFile(enPath, 'utf8')
  const zh = await readFile(zhPath, 'utf8')
  assert.match(en, /^# .+\n\n\[简体中文\]\([^\n]+\)/u, `${english} needs a top language link`)
  assert.match(zh, /^# .+\n\n\[English\]\([^\n]+\)/u, `${chinese} needs a top language link`)
  assert.equal((en.match(/^## /gmu) ?? []).length, (zh.match(/^## /gmu) ?? []).length)
  assert.equal((en.match(/^```/gmu) ?? []).length, (zh.match(/^```/gmu) ?? []).length)
  for (const [file, content] of [
    [enPath, en],
    [zhPath, zh],
  ]) {
    const label = relative(root, file)
    assert(content.length > 600, `${label} is too short to be a usable guide`)
    checkPrivateEnvironment(file, content)
    for (const match of content.matchAll(/https?:\/\/([a-z0-9.-]+)/giu)) {
      const host = match[1].toLowerCase()
      assert(
        host === 'localhost' ||
          host === '127.0.0.1' ||
          /^192\.0\.2\.\d{1,3}$/u.test(host) ||
          /^(?:[a-z0-9-]+\.)*example(?:\.com|\.org|\.net)?$/u.test(host),
        `${label} contains a non-example URL host`,
      )
    }
    for (const match of content.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1].split('#')[0]
      if (!target || /^[a-z]+:/iu.test(target)) continue
      assert(!target.startsWith('/'), `${label} must not link to an absolute filesystem path`)
      const destination = resolve(dirname(file), decodeURIComponent(target))
      assert(!relative(root, destination).startsWith('..'), `${label} link escapes project root`)
      await access(destination)
    }
  }
}

console.info(`${packaged ? 'Packaged' : 'Source'} English/Chinese guide pairs and links verified.`)
