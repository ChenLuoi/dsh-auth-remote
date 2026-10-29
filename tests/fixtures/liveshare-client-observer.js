// Observe the actual registration facade, including the kernel's later sink replacement.
{
  let facade
  Object.defineProperty(window, '__ModuleLoader__', {
    configurable: true,
    get() {
      return facade
    },
    set(value) {
      facade = value
      let load = value.load
      const observed = new WeakSet()
      const delegate = function (row) {
        if (row.id === 'dsh-auth-remote' && !observed.has(row.factory)) {
          const original = row.factory
          const factory = function (require) {
            const exports = original(require)
            window.__authRemoteExports = exports
            return {
              ...exports,
              apply(ctx) {
                window.__authRemoteContext = ctx
                if (window.__observeAuthRemoteForms)
                  ctx.inject(['configForms'], (scope) => {
                    window.__authRemoteConfigContext = scope
                    scope.effect(() => () => {
                      if (window.__authRemoteConfigContext === scope)
                        delete window.__authRemoteConfigContext
                    })
                  })
                window.__authRemoteApplies = (window.__authRemoteApplies ?? 0) + 1
                return exports.apply(ctx)
              },
            }
          }
          observed.add(original)
          observed.add(factory)
          row = { ...row, factory }
        }
        return load.call(this, row)
      }
      Object.defineProperty(value, 'load', {
        configurable: true,
        get() {
          return delegate
        },
        set(next) {
          load = next
        },
      })
    },
  })
}
