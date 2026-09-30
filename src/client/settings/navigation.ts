export type LoginReason = 'expired' | 'updated' | 'signed-out'

/** Let a security operation finish before background checks redirect its page. */
export class LoginNavigation {
  private holds = 0
  private expired = false
  private navigating = false

  constructor(private readonly assign: (reason: LoginReason) => void) {}

  hold(timeoutMs?: number): () => void {
    this.holds++
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      if (!active) return
      active = false
      clearTimeout(timer)
      this.holds--
      if (this.holds === 0 && this.expired) this.go('expired')
    }
    if (timeoutMs !== undefined) timer = setTimeout(release, timeoutMs)
    return release
  }

  go(reason: LoginReason): void {
    if (this.navigating) return
    if (reason === 'expired' && this.holds > 0) {
      this.expired = true
      return
    }
    this.navigating = true
    this.assign(reason)
  }
}
