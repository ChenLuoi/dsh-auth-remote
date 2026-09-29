import { assertRuntimeDirectory, ensureDevHome, port, runtime } from './dev-common.mjs'
import { dshVersion, packageName, prepareDshRuntime } from './runtime.mjs'

await ensureDevHome()
await prepareDshRuntime(runtime, `${packageName}-dev-runtime`)
await assertRuntimeDirectory()
console.info('Development root: .dev')
console.info('DSH_HOME: .dev/dsh-home')
console.info(`DSH: ${dshVersion} (.dev/runtime-${dshVersion}/node_modules/.bin/dsh)`)
console.info(`Local listener: http://127.0.0.1:${port}`)
