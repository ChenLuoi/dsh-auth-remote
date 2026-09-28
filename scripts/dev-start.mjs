import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { assertDevHome, dsh, dshEnv, home, port } from './dev-common.mjs'

await assertDevHome()
console.info('Starting isolated DSH_HOME: .dev/dsh-home')
console.info(`Local listener: http://127.0.0.1:${port}`)
const child = spawn(dsh, ['web', '--no-open', '--port', String(port)], {
  cwd: home,
  env: dshEnv(),
  stdio: ['inherit', 'pipe', 'pipe'],
})
for (const [input, output] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  createInterface({ input }).on('line', (line) => {
    output.write(`${line.replace(/([?&]token=)[^\s]+/gu, '$1[redacted]')}\n`)
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1)
})
