import { readFile } from 'node:fs/promises'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/u.test(version ?? ''))
  throw new Error('Usage: node scripts/release-notes.mjs VERSION')

const changelog = await readFile('CHANGELOG.md', 'utf8')
const heading = changelog.split('\n').find((line) => line.startsWith(`## ${version} - `))
if (!heading) throw new Error(`Missing changelog entry for ${version}`)
const notes = changelog.split(heading)[1].split(/^## /mu)[0].trim()
if (!notes) throw new Error(`Empty changelog entry for ${version}`)
process.stdout.write(`${notes}\n`)
