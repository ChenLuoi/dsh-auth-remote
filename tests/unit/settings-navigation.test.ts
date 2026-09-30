import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoginNavigation, type LoginReason } from '../../src/client/settings/navigation.js'

test('a completed security change wins over revocation detected before its response', () => {
  for (const reason of ['updated', 'signed-out'] as const) {
    const redirects: LoginReason[] = []
    const navigation = new LoginNavigation((value) => redirects.push(value))
    const release = navigation.hold()
    navigation.go('expired')
    assert.deepEqual(redirects, [])
    navigation.go(reason)
    release()
    navigation.go('expired')
    assert.deepEqual(redirects, [reason])
  }
})

test('failed or abandoned operations release deferred expiry exactly once', () => {
  const redirects: LoginReason[] = []
  const navigation = new LoginNavigation((reason) => redirects.push(reason))
  const release = navigation.hold()
  navigation.go('expired')
  release()
  release()
  navigation.go('updated')
  assert.deepEqual(redirects, ['expired'])
})

test('new backup codes remain available after the mutation finishes until acknowledged', () => {
  const redirects: LoginReason[] = []
  const navigation = new LoginNavigation((reason) => redirects.push(reason))
  const finishMutation = navigation.hold()
  navigation.go('expired')
  const finishSaving = navigation.hold()
  finishMutation()
  finishMutation()
  navigation.go('expired')
  assert.deepEqual(redirects, [])
  navigation.go('updated')
  finishSaving()
  assert.deepEqual(redirects, ['updated'])
})

test('an unresponsive operation cannot suppress session expiry indefinitely', async () => {
  const redirects: LoginReason[] = []
  let expired!: () => void
  const redirected = new Promise<void>((resolve) => {
    expired = resolve
  })
  const navigation = new LoginNavigation((reason) => {
    redirects.push(reason)
    expired()
  })
  const release = navigation.hold(10)
  navigation.go('expired')
  await redirected
  release()
  assert.deepEqual(redirects, ['expired'])
})
