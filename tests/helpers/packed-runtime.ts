import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedDshEnv } from '../../scripts/runtime.mjs'
import { archive, dsh, packageName } from './runtime.js'

export function packedCommand(
  home: string,
  args: string[],
  cwd = home,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const child = spawn(dsh, args, {
    cwd,
    env: { ...isolatedDshEnv(home), ...extraEnv },
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
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
  return {
    child,
    done,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await done
    },
  }
}

export async function packedAdmin(
  home: string,
  command: string,
  prompts: readonly (readonly [string, string])[] = [],
) {
  const args = ['plugin', '--profile', 'web', 'exec', packageName, command, '--lang', 'zh']
  if (prompts.length === 0) {
    const result = await packedCommand(home, [...args, '--json']).done
    assert.equal(result.code, 0, result.stderr)
    return result.stdout
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const child = spawn(
    'script',
    ['-q', '-e', '-f', '-c', [dsh, ...args].map(quote).join(' '), '/dev/null'],
    { cwd: home, env: isolatedDshEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let output = ''
  let stderr = ''
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
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 0, output + stderr)
    assert.equal(index, prompts.length)
    return output
  } finally {
    clearTimeout(timer)
  }
}

export async function packedProfile(config: Record<string, unknown>, strictFixture = false) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-native-packed-'))
  try {
    const installed = await packedCommand(home, ['plugin', '--profile', 'web', 'add', archive]).done
    assert.equal(installed.code, 0, installed.stderr)
    const profile = join(home, 'profiles/web')
    const cwd = join(home, 'launch-cwd')
    await mkdir(cwd)
    const lines = [
      '- id: auth-remote',
      '  config:',
      ...Object.entries(config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
    ]
    if (strictFixture) {
      const fixture = join(profile, 'strict-origin-fixture.mjs')
      await copyFile(new URL('../fixtures/strict-origin-fixture.mjs', import.meta.url), fixture)
      lines.push(
        '- insert:',
        '    - id: strict-origin-fixture',
        `      name: ${fixture}`,
        '      inject: [webServer]',
      )
    }
    await writeFile(join(profile, 'cordis.patch.yml'), lines.join('\n') + '\n')
    return { home, profile, cwd, cleanup: () => rm(home, { recursive: true, force: true }) }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
