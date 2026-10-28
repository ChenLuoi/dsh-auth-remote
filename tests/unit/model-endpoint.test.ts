import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isolatedDshEnv, localModelEndpoint } from '../helpers/runtime.js'

test('UI model fixture exposes only a local native patch and fails on unexpected requests', async () => {
  const quiet = await localModelEndpoint()
  assert.match(quiet.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/u)
  assert.deepEqual(quiet.patch, [
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${quiet.baseURL}`,
  ])
  await quiet.close()
  const active = await localModelEndpoint()
  assert.equal((await fetch(active.baseURL + '/models')).status, 500)
  assert.deepEqual(active.requests, [{ method: 'GET', path: '/anthropic/models' }])
  await assert.rejects(active.close(), /unexpected requests/u)
  const env = isolatedDshEnv('/tmp/isolated-model-test')
  assert.equal(env.HOME, env.DSH_HOME)
  for (const key of [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ])
    assert(!Object.hasOwn(env, key))
})
