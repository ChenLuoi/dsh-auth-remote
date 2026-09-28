import {
  checkDshVersion,
  dshVersion,
  packageName,
  prepareDshRuntime,
  selectedTestDsh,
  testRuntime,
} from './runtime.mjs'

const bin = selectedTestDsh()
if (process.env.DSH_TEST_BIN) checkDshVersion(bin)
else await prepareDshRuntime(testRuntime, `${packageName}-test-runtime`)
console.info(
  `Test DSH runtime: ${process.env.DSH_TEST_BIN ? 'DSH_TEST_BIN' : '.cache/test-runtime'} (${dshVersion})`,
)
