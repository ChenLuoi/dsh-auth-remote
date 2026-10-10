import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const nativeCertPath = fileURLToPath(
  new URL('../fixtures/tls/native.test.cert.pem', import.meta.url),
)
export const nativeKeyPath = fileURLToPath(
  new URL('../fixtures/tls/native.test.key.pem', import.meta.url),
)
export const nativeCertificate = await readFile(nativeCertPath)

export interface NativeRequestOptions {
  method?: string
  origin?: string | null
  host?: string
  cookie?: string
  body?: Buffer | string
  headers?: Record<string, string>
  servername?: string
}

export function nativeRequest(target: string, path: string, options: NativeRequestOptions = {}) {
  const url = new URL(path, target)
  const origin = options.origin === undefined ? new URL(target).origin : options.origin
  const headers = {
    ...(options.host ? { host: options.host } : {}),
    ...(origin !== null ? { origin } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...options.headers,
  }
  return (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: options.method ?? 'GET',
    headers,
    ca: nativeCertificate,
    ...(options.servername ? { servername: options.servername } : {}),
    agent: false,
  })
}

export function nativeHttp(target: string, path: string, options: NativeRequestOptions = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>(
    (resolve, reject) => {
      const req = nativeRequest(target, path, options)
      req.setTimeout(5000, () => req.destroy(new Error('native request timed out')))
      req.once('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(options.body)
    },
  )
}

export function nativeStream(target: string, path: string, options: NativeRequestOptions = {}) {
  return new Promise<{ closed: Promise<void>; close(): void }>((resolve, reject) => {
    const req = nativeRequest(target, path, options)
    req.once('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`native stream status ${res.statusCode}`))
        return
      }
      const closed = new Promise<void>((done) => res.once('close', done))
      res.once('data', (chunk: Buffer) => {
        if (!chunk.toString('utf8').includes('ready'))
          reject(new Error('native stream never became ready'))
        else resolve({ closed, close: () => req.destroy() })
      })
      res.on('error', () => {})
    })
    req.on('error', reject)
    req.end(options.body)
  })
}
