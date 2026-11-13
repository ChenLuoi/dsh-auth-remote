import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decorateNativeAccountEntry } from '../../src/client/account/native-entry.js'
import { installManualAccountLogin } from '../../src/client/account/index.js'
import { ACCOUNT_LOGIN_CAPABILITY } from '../../src/shared/account-login.js'

function fixture() {
  const Native = () => null
  const Wrapper = () => null
  const entry = {
    component: Native,
    children: { notifications: {} },
    inject: () => ({}),
    options: { priority: 2 },
    registrant: 'native account',
  }
  const identity = { ...entry }
  let roots = 0
  let inactive = false
  const slots = {
    provideRoot() {
      roots++
      return () => {
        assert.equal(inactive, true, 'deactivate before triggering redraw')
        roots--
      }
    },
  }
  return {
    Native,
    Wrapper,
    entry,
    identity,
    slots,
    deactivate: () => {
      inactive = true
    },
    roots: () => roots,
    inactive: () => inactive,
  }
}

test('native account decoration retains ownership and releases its redraw contribution exactly once', () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) {
    const dispose = decorateNativeAccountEntry(f.entry, f.Wrapper, f.slots, f.deactivate)
    assert.equal(f.entry.component, f.Wrapper)
    for (const key of ['children', 'inject', 'options', 'registrant'] as const)
      assert.equal(f.entry[key], f.identity[key])
    assert.equal(f.roots(), 1)
    dispose()
    dispose()
    assert.equal(f.roots(), 0)
    assert.equal(f.entry.component, f.Native)
  }
})

test('native account cleanup preserves later writers and independently decorates a replacement entry', () => {
  const f = fixture()
  const dispose = decorateNativeAccountEntry(f.entry, f.Wrapper, f.slots, f.deactivate)
  const ThirdParty = () => null
  f.entry.component = ThirdParty
  const replacement = fixture()
  const releaseReplacement = decorateNativeAccountEntry(
    replacement.entry,
    replacement.Wrapper,
    replacement.slots,
    replacement.deactivate,
  )
  dispose()
  assert.equal(f.entry.component, ThirdParty)
  assert.equal(f.inactive(), true)
  assert.equal(f.roots(), 0)
  assert.equal(replacement.entry.component, replacement.Wrapper)
  releaseReplacement()
  assert.equal(replacement.entry.component, replacement.Native)
})

test('native account shape and redraw failures leave no partial decoration', () => {
  for (const broken of ['component', 'children', 'inject', 'root', 'frozen'] as const) {
    const f = fixture()
    if (broken === 'component') Object.assign(f.entry, { component: null })
    if (broken === 'children') Object.assign(f.entry, { children: null })
    if (broken === 'inject') Object.assign(f.entry, { inject: null })
    if (broken === 'frozen') Object.freeze(f.entry)
    const original = f.entry.component
    assert.throws(
      () =>
        decorateNativeAccountEntry(
          f.entry,
          f.Wrapper,
          broken === 'root' ? {} : f.slots,
          f.deactivate,
        ),
      /child ownership/,
    )
    assert.equal(f.entry.component, original)
    assert.equal(f.roots(), 0)
  }
  for (const provideRoot of [
    () => {
      throw new Error('redraw failed')
    },
    () => undefined,
  ]) {
    const f = fixture()
    assert.throws(
      () => decorateNativeAccountEntry(f.entry, f.Wrapper, { provideRoot } as never, f.deactivate),
      /redraw/,
    )
    assert.equal(f.entry.component, f.Native)
    assert.equal(f.inactive(), true)
    assert.equal(f.roots(), 0)
  }
})

test('native account cleanup releases redraw even if a dialog subscriber throws', () => {
  const f = fixture()
  const dispose = decorateNativeAccountEntry(f.entry, f.Wrapper, f.slots, () => {
    f.deactivate()
    throw new Error('dialog subscriber failed')
  })
  assert.throws(dispose, /dialog subscriber failed/)
  assert.equal(f.entry.component, f.Native)
  assert.equal(f.roots(), 0)
  dispose()
})

test('account entry discovery cleans failed subscriptions, retries late entries and deduplicates its own wrapper', () => {
  const page = globalThis as Record<string, unknown>
  const previous = page[ACCOUNT_LOGIN_CAPABILITY]
  page[ACCOUNT_LOGIN_CAPABILITY] = true
  try {
    for (const late of [false, true]) {
      const f = fixture()
      const entry = { ...f.entry, locale: 'settings.account' }
      let entries = late ? [] : [entry]
      const listeners = new Set<() => void>()
      let cleanup: (() => void) | undefined
      const slots = {
        entries: () => entries,
        subscribe(_name: string, callback: () => void) {
          listeners.add(callback)
          return () => {
            listeners.delete(callback)
          }
        },
        inject(name: string, callback: () => () => void) {
          if (name === 'settings.launcher') cleanup = callback()
        },
        register: () => () => {},
        provideRoot: undefined as typeof f.slots.provideRoot | undefined,
      }
      const forms = { get: () => ({}), describe: () => ({}) }
      const ctx = {
        get: (name: string) =>
          name === 'slots' ? slots : name === 'configForms' ? forms : undefined,
        locale: { bind: () => () => '' },
        inject(_names: string[], callback: (value: unknown) => void) {
          callback(ctx)
        },
      }
      if (!late) {
        assert.throws(() => installManualAccountLogin(ctx as never), /child ownership/)
        assert.equal(listeners.size, 0)
        assert.equal(entry.component, f.Native)
      } else {
        installManualAccountLogin(ctx as never)
        entries = [entry]
        const update = [...listeners][0]!
        assert.throws(update, /child ownership/)
        assert.equal(entry.component, f.Native)
        let failRelease = false
        slots.provideRoot = () => {
          const release = f.slots.provideRoot()
          return () => {
            release()
            if (failRelease) throw new Error('redraw cleanup failed')
          }
        }
        update()
        const wrapper = entry.component
        assert.notEqual(wrapper, f.Native)
        update()
        assert.equal(entry.component, wrapper)
        assert.equal(f.roots(), 1)
        const replacement = { ...f.entry, locale: 'settings.account' }
        entries = [replacement]
        // A redraw listener may throw during removal; discovery must remain retryable.
        f.deactivate()
        failRelease = true
        assert.throws(update, /redraw cleanup failed/)
        failRelease = false
        assert.equal(entry.component, f.Native)
        assert.equal(replacement.component, f.Native)
        f.deactivate()
        update()
        assert.notEqual(replacement.component, f.Native)
        assert.equal(f.roots(), 1)
        // The adapter's own deactivation differs from this fixture's observer.
        f.deactivate()
        cleanup!()
        assert.equal(replacement.component, f.Native)
        assert.equal(f.roots(), 0)
        assert.equal(listeners.size, 0)
      }
    }
  } finally {
    if (previous === undefined) delete page[ACCOUNT_LOGIN_CAPABILITY]
    else page[ACCOUNT_LOGIN_CAPABILITY] = previous
  }
})
