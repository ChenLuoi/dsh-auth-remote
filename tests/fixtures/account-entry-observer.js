// Observe real caller-scoped APIs and React props; never supply a renderSlot binding.
{
  const state = {
    modules: [],
    records: [],
    renders: [],
    roots: 0,
    registrations: 0,
    starts: 0,
    settledStarts: 0,
    popups: [],
    applies: { auth: 0, native: 0 },
    disposals: { auth: 0, native: 0 },
  }
  window.__accountEntry = state
  const open = window.open
  window.open = function (...args) {
    const popup = Reflect.apply(open, this, args)
    state.popups.push(popup)
    return popup
  }
  const ids = new WeakMap()
  let nextId = 1
  const id = (value) => {
    if (value === null || !['object', 'function'].includes(typeof value)) return value ?? null
    if (!ids.has(value)) ids.set(value, nextId++)
    return ids.get(value)
  }
  const entries = () => state.slots?.entries('settings.launcher') ?? []
  const noteWrapper = () => {
    for (const record of state.records) {
      if (!entries().includes(record.entry) || record.entry.component === record.component) continue
      record.wrapper = record.entry.component
    }
  }
  state.retainWrapper = () => {
    const record = state.records.at(-1)
    const wrapper = record.entry.component
    const component = (props) => state.react.createElement(wrapper, props)
    state.thirdParty = { entry: record.entry, component, native: record.component }
    record.entry.component = component
    state.thirdParty.release = state.native.ctx
      .get('slots')
      .provideRoot({ props: { accountEntryThirdParty: true } })
  }
  state.snapshot = () => {
    const launchers = entries().filter((entry) => entry.locale === 'settings.account')
    const entry = launchers[0]
    const record =
      state.records.findLast((record) => record.entry === entry) ?? state.records.at(-1)
    const children = state.slots?.entries('settings.launcher.notifications') ?? []
    return {
      entryCount: launchers.length,
      entryId: id(entry),
      records: state.records.length,
      modules: state.modules.filter(
        (name) => name.includes('account') || name === 'dsh-auth-remote',
      ),
      childIds: children.map(id),
      childRegistrants: children.map((child) => child.registrant),
      sameEntry: entry === record?.entry,
      sameChildren: entry?.children === record?.children,
      sameInject: entry?.inject === record?.inject,
      sameOptions: entry?.options === record?.options,
      sameRegistrant: entry?.registrant === record?.registrant,
      decorated: !!record?.wrapper && entry?.component === record.wrapper,
      original: !!record && entry?.component === record.component,
      roots: state.roots,
      registrations: state.registrations,
      starts: state.starts,
      settledStarts: state.settledStarts,
      popupClosed: state.popups.map((popup) => popup?.closed ?? null),
      applies: { ...state.applies },
      disposals: { ...state.disposals },
      renders: state.renders.slice(-12),
    }
  }
  const contexts = new WeakMap()
  function observeContext(ctx, kind) {
    if (contexts.has(ctx)) return contexts.get(ctx)
    const slots = ctx.get('slots')
    state.slots = slots
    const observedSlots = new Proxy(slots, {
      get(target, key) {
        if (key === 'register')
          return (options, component) => {
            if (options.name === 'settings.launcher' && options.locale === 'settings.account')
              state.registrations++
            const release = target.register(options, component)
            if (kind === 'native' && options.name === 'settings.launcher') {
              const entry = target
                .entries(options.name)
                .find(
                  (entry) =>
                    entry.locale === 'settings.account' &&
                    (entry.component === component || entry.children),
                )
              if (!entry) throw new Error('Native account registration was not observable')
              state.records.push({
                entry,
                component,
                children: entry.children,
                inject: entry.inject,
                options: entry.options,
                registrant: entry.registrant,
                declaredChildren: options.children,
                declaredInject: options.inject,
              })
              noteWrapper()
            }
            return release
          }
        if (key === 'provideRoot')
          return (contribution) => {
            const owned =
              kind === 'auth' && contribution.props?.authRemoteAccountDecoration === true
            const release = target.provideRoot(contribution)
            if (!owned) return release
            state.roots++
            noteWrapper()
            let released = false
            return () => {
              if (!released) {
                released = true
                state.roots--
              }
              return release()
            }
          }
        const member = Reflect.get(target, key)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const proxy = new Proxy(ctx, {
      get(target, key) {
        if (key === 'slots') return observedSlots
        if (key === 'get')
          return (name, ...args) => (name === 'slots' ? observedSlots : target.get(name, ...args))
        if (key === 'inject' && kind === 'auth')
          return (names, callback, ...args) =>
            target.inject(names, (scope) => callback(observeContext(scope, kind)), ...args)
        const member = Reflect.get(target, key, target)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    contexts.set(ctx, proxy)
    return proxy
  }
  let facade
  Object.defineProperty(window, '__ModuleLoader__', {
    configurable: true,
    get: () => facade,
    set(value) {
      facade = value
      let load = value.load
      const seen = new WeakSet()
      const delegate = function (row) {
        state.modules.push(row.id)
        if (
          !seen.has(row.factory) &&
          ['dsh-auth-remote', '@deepseek-ai/dsh-client-ui-settings-account'].includes(row.id)
        ) {
          const kind = row.id === 'dsh-auth-remote' ? 'auth' : 'native'
          const original = row.factory
          const factory = (require) => {
            const exports = original(
              new Proxy(require, {
                apply(target, receiver, args) {
                  const [name] = args
                  const dependency = Reflect.apply(target, receiver, args)
                  if (name !== 'react') return dependency
                  state.react = dependency
                  if (kind !== 'auth') return dependency
                  return {
                    ...dependency,
                    createElement(component, props, ...children) {
                      const record = state.records.findLast(
                        (record) =>
                          record.component === component && entries().includes(record.entry),
                      )
                      if (record)
                        state.renders.push({
                          entryId: id(record.entry),
                          bindingId: id(props.renderSlot),
                          bindingType: typeof props.renderSlot,
                        })
                      if (!record || typeof props.start !== 'function')
                        return dependency.createElement(component, props, ...children)
                      return dependency.createElement(
                        component,
                        {
                          ...props,
                          async start(...args) {
                            state.starts++
                            try {
                              return await props.start(...args)
                            } finally {
                              state.settledStarts++
                            }
                          },
                        },
                        ...children,
                      )
                    },
                  }
                },
              }),
            )
            const wrapped = {
              ...exports,
              apply(ctx) {
                state[kind] = { ctx, exports: wrapped, parent: ctx.fiber.parent }
                state.applies[kind]++
                ctx.effect(() => () => {
                  state.disposals[kind]++
                })
                return exports.apply(observeContext(ctx, kind))
              },
            }
            return wrapped
          }
          seen.add(original)
          seen.add(factory)
          row = { ...row, factory }
        }
        return load.call(this, row)
      }
      Object.defineProperty(value, 'load', {
        configurable: true,
        get: () => delegate,
        set: (next) => {
          load = next
        },
      })
    },
  })
}
