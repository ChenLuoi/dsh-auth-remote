// Observe native factories and retain their real disposers; no production debug API.
{
  const state = { renders: [], modules: [], registrations: 0 }
  window.__settingsIcon = state
  let facade
  Object.defineProperty(window, '__ModuleLoader__', {
    configurable: true,
    get: () => facade,
    set(value) {
      facade = value
      let load = value.load
      const observed = new WeakSet()
      const delegate = function (row) {
        if (
          !observed.has(row.factory) &&
          (row.id === 'dsh-auth-remote' || row.id.endsWith('dsh-client-ui-settings-general'))
        ) {
          const original = row.factory
          const factory = function (require) {
            const exports = original((name) => {
              const dependency = require(name)
              if (row.id === 'dsh-auth-remote') state.modules.push(name)
              if (name === '@deepseek-ai/dsh-client-ui-primitives')
                state.nativeShield = dependency.IconShieldOutlineMedium
              return dependency
            })
            const wrapped = {
              ...exports,
              apply(ctx) {
                if (row.id !== 'dsh-auth-remote') {
                  state.general = { ctx, exports: wrapped }
                  return exports.apply(ctx)
                }
                state.ctx = ctx
                state.exports = exports
                const slots = ctx.get('slots')
                // Calls still execute on the original caller-scoped native facade.
                const observedSlots = new Proxy(slots, {
                  get(target, key) {
                    if (key === 'register')
                      return (options, component) => {
                        if (options.name !== 'settings.section.icon')
                          return target.register(options, component)
                        state.registrations++
                        state.releaseIcon = target.register(options, (props) => {
                          const element = component(props)
                          state.renders.push({
                            size: props.size,
                            active: props.active,
                            native: element.type === state.nativeShield,
                          })
                          return element
                        })
                        return state.releaseIcon
                      }
                    const member = Reflect.get(target, key)
                    return typeof member === 'function' ? member.bind(target) : member
                  },
                })
                const observedContext = new Proxy(ctx, {
                  get(target, key) {
                    if (key === 'get')
                      return (name, ...args) =>
                        name === 'slots' ? observedSlots : target.get(name, ...args)
                    const member = Reflect.get(target, key)
                    return typeof member === 'function' ? member.bind(target) : member
                  },
                })
                return exports.apply(observedContext)
              },
            }
            return wrapped
          }
          observed.add(original)
          observed.add(factory)
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
