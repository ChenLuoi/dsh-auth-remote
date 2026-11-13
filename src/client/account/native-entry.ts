interface AccountEntry<Component> {
  component: Component
  children?: object
  options: object
  inject?: (...args: never[]) => object
}

export interface AccountRoot {
  provideRoot?: (contribution: { props: Record<string, unknown> }) => () => void
}

/** Private StoredEntry adaptation: leave child authorization with its native owner. */
export function decorateNativeAccountEntry<Component>(
  entry: AccountEntry<Component>,
  wrapper: Component,
  slots: AccountRoot,
  deactivate: () => void,
): () => void {
  const property = Object.getOwnPropertyDescriptor(entry, 'component')
  if (
    !property?.writable ||
    typeof entry.component !== 'function' ||
    typeof wrapper !== 'function' ||
    !entry.children ||
    typeof entry.children !== 'object' ||
    Array.isArray(entry.children) ||
    !entry.options ||
    typeof entry.options !== 'object' ||
    typeof entry.inject !== 'function' ||
    typeof slots.provideRoot !== 'function'
  )
    throw new Error('auth-remote: native account entry cannot preserve child ownership')

  const native = entry.component
  let release: (() => void) | undefined
  let active = true
  const dispose = () => {
    if (!active) return
    active = false
    try {
      deactivate()
    } finally {
      try {
        if (entry.component === wrapper) entry.component = native
      } finally {
        release?.()
      }
    }
  }
  try {
    entry.component = wrapper
    const redraw = slots.provideRoot({ props: { authRemoteAccountDecoration: true } })
    if (typeof redraw !== 'function') throw new Error('auth-remote: account redraw is unavailable')
    release = redraw
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
