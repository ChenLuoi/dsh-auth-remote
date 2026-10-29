import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { rememberLocale } from '../../src/client/settings/locale-memory.js'
import { localeMemoryKey } from '../../src/shared/i18n.js'

type Snapshot = ConfigFormSnapshot<{ preference?: string }>
function fixture(initial: Partial<Snapshot>) {
  let snapshot: Snapshot = {
    status: 'loading',
    value: undefined,
    base: {},
    user: {},
    revision: undefined,
    writable: true,
    ...initial,
  }
  let failRead = false
  let failStorage = false
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const values = new Map([
    [localeMemoryKey, 'ja-JP'],
    ['dsh-auth-remote.locale', 'zh'],
  ])
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (failStorage) throw new Error('storage blocked')
      return {
        setItem(key: string, value: string) {
          calls.push(`set:${key}:${value}`)
          values.set(key, value)
        },
        removeItem(key: string) {
          calls.push(`remove:${key}`)
          values.delete(key)
        },
        getItem() {
          throw new Error('synchronization must not read storage')
        },
      }
    },
  })
  const form = {
    getSnapshot() {
      calls.push('snapshot')
      if (failRead) throw new Error('temporary form read failure')
      return snapshot
    },
    subscribe(listener: () => void) {
      calls.push('subscribe')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    form,
    values,
    calls,
    listeners,
    failRead(value: boolean) {
      failRead = value
    },
    failStorage(value: boolean) {
      failStorage = value
    },
    publish(next: Partial<Snapshot>) {
      snapshot = { ...snapshot, ...next }
      for (const notify of listeners) notify()
    },
    cleanup() {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    },
  }
}

test('accepted locale memory subscribes first, reads immediately, and releases its listener', () => {
  const f = fixture({ status: 'ready', value: { preference: 'pt-BR' } })
  try {
    const stop = rememberLocale(f.form)
    assert.deepEqual(f.calls, ['subscribe', 'snapshot', `set:${localeMemoryKey}:pt-BR`])
    assert.equal(f.values.get('dsh-auth-remote.locale'), 'zh')
    assert.equal(f.listeners.size, 1)
    stop()
    assert.equal(f.listeners.size, 0)
    f.publish({ value: { preference: 'de' } })
    assert.equal(f.values.get(localeMemoryKey), 'pt-BR')
  } finally {
    f.cleanup()
  }
})

test('loading, unavailable and undefined accepted values preserve memory until a ready snapshot', () => {
  const f = fixture({})
  try {
    const stop = rememberLocale(f.form)
    f.publish({ status: 'loading', value: { preference: 'en' } })
    f.publish({ status: 'unavailable', value: {} })
    f.publish({ status: 'ready', value: undefined })
    assert.equal(f.values.get(localeMemoryKey), 'ja-JP')
    assert.equal(
      f.calls.some((value) => value.startsWith('set:') || value.startsWith('remove:')),
      false,
    )
    f.publish({ status: 'ready', value: { preference: 'ru' } })
    assert.equal(f.values.get(localeMemoryKey), 'ru')
    stop()
  } finally {
    f.cleanup()
  }
})

test('explicit cleared preference removes only the new key; unsupported accepted strings stay verbatim', () => {
  const f = fixture({ status: 'ready', value: { preference: 'ko-KR' } })
  try {
    const stop = rememberLocale(f.form)
    assert.equal(f.values.get(localeMemoryKey), 'ko-KR')
    f.publish({ value: {} })
    assert.equal(f.values.has(localeMemoryKey), false)
    assert.equal(f.values.get('dsh-auth-remote.locale'), 'zh')
    f.publish({ value: { preference: 'PT-br' } })
    assert.equal(f.values.get(localeMemoryKey), 'PT-br')
    f.publish({ value: { preference: null } as unknown as { preference?: string } })
    assert.equal(f.values.get(localeMemoryKey), 'PT-br')
    stop()
  } finally {
    f.cleanup()
  }
})

test('read and storage errors preserve authentication and recover only on a later native notification', () => {
  const f = fixture({ status: 'ready', value: { preference: 'es' } })
  try {
    f.failRead(true)
    const stop = rememberLocale(f.form)
    assert.equal(f.values.get(localeMemoryKey), 'ja-JP')
    f.failRead(false)
    f.failStorage(true)
    assert.doesNotThrow(() => f.publish({ value: { preference: 'fr' } }))
    assert.equal(f.values.get(localeMemoryKey), 'ja-JP')
    f.failStorage(false)
    assert.equal(f.values.get(localeMemoryKey), 'ja-JP')
    f.publish({ value: { preference: 'de' } })
    assert.equal(f.values.get(localeMemoryKey), 'de')
    stop()
  } finally {
    f.cleanup()
  }
})
