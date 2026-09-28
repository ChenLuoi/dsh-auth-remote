import type { ReadStream, WriteStream } from 'node:tty'
import { CliDiagnostic } from './language.js'

/** One terminal session; secret input is read in raw mode and never echoed. */
export class TerminalPrompt {
  private readonly pending: string[] = []
  private wake: (() => void) | undefined
  private readonly decoder = new TextDecoder()
  private readonly previousRaw: boolean
  private closed = false
  private ended = false
  private skipLf = false

  constructor(
    private readonly input = process.stdin as ReadStream,
    private readonly output = process.stdout as WriteStream,
  ) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
      throw new CliDiagnostic(
        'cliErrorTerminalRequired',
        'dsh-auth-remote: an interactive terminal is required',
      )
    this.previousRaw = input.isRaw
    input.setRawMode(true)
    input.resume()
    input.on('data', this.onData)
    input.once('end', this.onEnd)
  }

  private readonly onData = (chunk: Buffer): void => {
    for (const char of this.decoder.decode(chunk, { stream: true })) this.pending.push(char)
    this.wake?.()
    this.wake = undefined
  }

  private readonly onEnd = (): void => {
    this.ended = true
    this.wake?.()
    this.wake = undefined
  }

  private async take(): Promise<string> {
    while (this.pending.length === 0) {
      if (this.closed || this.ended)
        throw new CliDiagnostic('cliErrorTerminalClosed', 'dsh-auth-remote: terminal input closed')
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    const char = this.pending.shift()!
    if (this.skipLf) {
      this.skipLf = false
      if (char === '\n') return this.take()
    }
    return char
  }

  async ask(label: string, secret = false, maxCharacters = 256): Promise<string> {
    if (this.closed)
      throw new CliDiagnostic('cliErrorTerminalClosed', 'dsh-auth-remote: terminal input closed')
    this.output.write(label)
    const answer: string[] = []
    let escape = false
    for (;;) {
      const char = await this.take()
      if (escape) {
        if (/[A-Za-z~]/u.test(char)) escape = false
        continue
      }
      if (char === '\u001b') {
        escape = true
        continue
      }
      if (char === '\u0003')
        throw new CliDiagnostic('cliErrorCancelled', 'dsh-auth-remote: cancelled')
      if (char === '\u0004')
        throw new CliDiagnostic('cliErrorTerminalClosed', 'dsh-auth-remote: terminal input closed')
      if (char === '\r' || char === '\n') {
        if (char === '\r') this.skipLf = true
        this.output.write('\n')
        return answer.join('')
      }
      if (char === '\u007f' || char === '\b') {
        if (answer.length > 0) {
          answer.pop()
          if (!secret) this.output.write('\b \b')
        }
        continue
      }
      if (/[\u0000-\u001f\u007f]/u.test(char)) continue
      if (answer.length >= maxCharacters) continue
      answer.push(char)
      if (!secret) this.output.write(char)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.setRawMode(this.previousRaw)
    this.input.pause()
    this.wake?.()
    this.wake = undefined
  }
}
