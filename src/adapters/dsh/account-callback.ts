import { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ACCOUNT_CALLBACK_PATH } from '../../shared/account-login.js'

/** Retain the native temporary handler without exposing a second callback entry. */
export class AccountCallbackBridge {
  private handler: WebRoute['handler'] | undefined

  capture(route: WebRoute): { handler: WebRoute['handler']; dispose(): void } | undefined {
    if (route.kind !== 'exact' || route.path !== ACCOUNT_CALLBACK_PATH) return
    const handler = route.handler
    this.handler = handler
    return {
      handler: (_req, res) => {
        res.writeHead(403, { 'cache-control': 'no-store' }).end()
      },
      dispose: () => {
        if (this.handler === handler) this.handler = undefined
      },
    }
  }

  /** Use Node's actual response lifecycle: DSH awaits its completion during cleanup. */
  async submit(query: URLSearchParams): Promise<number> {
    const handler = this.handler
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
