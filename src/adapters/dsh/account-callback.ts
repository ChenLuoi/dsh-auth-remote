import { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ACCOUNT_CALLBACK_PATH } from '../../shared/account-login.js'

/** Deliver a validated manual callback into the native request lifecycle. */
export class AccountCallbackBridge {
  private handler: WebRoute['handler'] | undefined
  private eventHandler: WebRoute['handler'] | undefined

  constructor(private readonly ownsCallback: () => boolean | Promise<boolean> = () => true) {}

  get available(): boolean {
    return this.eventHandler !== undefined || this.handler !== undefined
  }

  useRequestEvent(handler: WebRoute['handler']): void {
    this.eventHandler = handler
  }

  reserved(): boolean | Promise<boolean> {
    return this.ownsCallback()
  }

  capture(route: WebRoute): { handler: WebRoute['handler']; dispose(): void } | undefined {
    if (route.kind !== 'exact' || route.path !== ACCOUNT_CALLBACK_PATH) return
    const handler = route.handler
    this.handler = handler
    return {
      handler: async (req, res) => {
        if (await this.ownsCallback()) res.writeHead(403, { 'cache-control': 'no-store' }).end()
        else return handler(req, res)
      },
      dispose: () => {
        if (this.handler === handler) this.handler = undefined
      },
    }
  }

  /** Use Node's actual response lifecycle: DSH awaits its completion during cleanup. */
  async submit(query: URLSearchParams, origin: string): Promise<number> {
    const handler = this.eventHandler ?? this.handler
    if (!handler) return 410
    // An in-memory socket discards the native completion redirect/HTML. No URL
    // from the clipboard is ever used as a request destination or followed.
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done()
      },
    })
    const request = new IncomingMessage(socket as Socket)
    request.method = 'GET'
    request.url = `${ACCOUNT_CALLBACK_PATH}?${query}`
    if (this.eventHandler) {
      const host = new URL(origin).host
      request.headers.host = host
      request.rawHeaders = ['Host', host]
    }
    const response = new ServerResponse(request)
    response.assignSocket(socket as Socket)
    // A real HTTP server closes/detaches the connection after a response.
    // Supply that close event too, so stream.finished settles on Node 24+.
    response.once('finish', () => socket.destroy())
    const completed = finished(response, { cleanup: true })
    void completed.catch(() => undefined)
    try {
      await handler(request, response)
      await completed
      return response.statusCode
    } finally {
      response.destroy()
      socket.destroy()
    }
  }
}
