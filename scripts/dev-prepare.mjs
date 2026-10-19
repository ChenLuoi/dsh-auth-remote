import {
  assertRuntimeDirectory,
  devRoot,
  ensureDevHome,
  home,
  port,
  runtime,
} from './dev-common.mjs'
import { dshVersion, packageName, prepareDshRuntime } from './runtime.mjs'

await ensureDevHome()
await prepareDshRuntime(runtime, `${packageName}-dev-runtime`)
await assertRuntimeDirectory()
console.info(`Development root: ${devRoot}`)
console.info(`DSH_HOME: ${home}`)
console.info(`DSH: ${dshVersion} (${runtime}/node_modules/.bin/dsh)`)
console.info(`Local listener: http://127.0.0.1:${port}`)
