import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'

const examples = join(import.meta.dirname, '../examples')

async function yamlFile(name) {
  const document = parseDocument(await readFile(join(examples, name), 'utf8'))
  assert.deepEqual(document.errors, [], `${name} must parse as YAML`)
  assert.ok(
    document.warnings.every((warning) =>
      /Unresolved tag: tag:yaml.org,2002:js/u.test(warning.message),
    ),
    `${name} has an unexpected YAML warning`,
  )
  return document.toJS()
}

const rows = await yamlFile('web-profile-auth-remote.patch.yml')
assert.ok(Array.isArray(rows))
assert.deepEqual(
  rows.map((item) => item.id),
  ['webserver', 'auth-remote'],
)
const row = (id) => rows.find((item) => item.id === id)
assert.equal(row('webserver').disabled, true)
assert.deepEqual(row('auth-remote').config, {
  allowedOrigins: ['https://dsh.example.com'],
  requireTotp: true,
  sessionHours: 168,
  preserveOriginPaths: [],
})

const traefik = (await yamlFile('traefik-dsh.yml')).http
const router = traefik.routers['dsh-auth-remote']
const service = traefik.services['dsh-auth-remote'].loadBalancer
assert.equal(router.rule, 'Host(`dsh.example.com`)')
assert.deepEqual(router.entryPoints, ['websecure'])
assert.equal(router.service, 'dsh-auth-remote')
assert.equal(router.tls.certResolver, 'replace-with-your-resolver')
assert.equal(router.middlewares, undefined)
assert.equal(service.passHostHeader, true)
assert.equal(service.servers[0].url, 'http://dsh-upstream.internal:13090')
assert.equal(service.responseForwarding.flushInterval, '-1ms')

const nginx = await readFile(join(examples, 'nginx.conf'), 'utf8')
for (const directive of [
  /map \$http_upgrade \$connection_upgrade\s*\{/u,
  /listen 443 ssl;/u,
  /server_name dsh\.example\.com;/u,
  /ssl_certificate \/etc\/nginx\/tls\/dsh\.example\.com\.crt;/u,
  /ssl_certificate_key \/etc\/nginx\/tls\/dsh\.example\.com\.key;/u,
  /proxy_pass http:\/\/127\.0\.0\.1:13090;/u,
  /proxy_http_version 1\.1;/u,
  /proxy_set_header Host \$http_host;/u,
  /proxy_set_header Origin \$http_origin;/u,
  /proxy_set_header Upgrade \$http_upgrade;/u,
  /proxy_set_header Connection \$connection_upgrade;/u,
  /proxy_buffering off;/u,
  /proxy_request_buffering off;/u,
  /proxy_cache off;/u,
  /proxy_read_timeout 3600s;/u,
  /proxy_send_timeout 3600s;/u,
])
  assert.match(nginx, directive)

for (const name of ['web-profile-auth-remote.patch.yml', 'traefik-dsh.yml', 'nginx.conf']) {
  const source = await readFile(join(examples, name), 'utf8')
  assert.match(source, /dsh\.example\.com/u)
  assert.doesNotMatch(source, /\/home\/|\/Users\//u)
}
console.info('Generic profile, Traefik and Nginx authority/streaming examples verified.')

for (const source of ['README.md', 'docs/development.md', 'docs/deployment.md']) {
  const filename = join(import.meta.dirname, '..', source)
  const markdown = await readFile(filename, 'utf8')
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0]
    if (!target || /^[a-z]+:/iu.test(target)) continue
    await access(resolve(dirname(filename), decodeURIComponent(target)))
  }
}
console.info('README and delivery-document local links verified.')
