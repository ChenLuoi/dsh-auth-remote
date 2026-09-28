/** Test-process-only Host entry using the production browser capability adapter. */
import { installAuthenticatedHostCapability } from '../../../dist/index.js'

export const inject = ['webServer']

export function apply(ctx) {
  installAuthenticatedHostCapability(ctx)
}
