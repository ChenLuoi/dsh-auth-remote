import { build, context } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const common = {
  bundle: true,
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
}
const builds = [
  {
    ...common,
    entryPoints: { index: 'src/index.ts', cli: 'src/cli/index.ts' },
    outdir: 'dist',
    platform: 'node',
    target: 'node24',
    format: 'esm',
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...common,
    packages: 'bundle',
    external: ['@deepseek-ai/*', 'react', 'react/*'],
    entryPoints: ['src/client/index.ts'],
    outfile: 'dist/client.js',
    platform: 'browser',
    target: 'es2023',
    format: 'cjs',
    tsconfig: 'tsconfig.client.json',
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  },
  {
    ...common,
    packages: 'bundle',
    entryPoints: ['src/client/login/index.ts'],
    outfile: 'dist/login.js',
    platform: 'browser',
    target: 'es2023',
    format: 'iife',
    tsconfig: 'tsconfig.client.json',
  },
]

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all(builds.map((options) => context(options)))
  await Promise.all(contexts.map((entry) => entry.watch()))
  console.info('Watching source files. Restart the isolated DSH instance after rebuilding.')
  const shutdown = async () => {
    await Promise.all(contexts.map((entry) => entry.dispose()))
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
} else {
  const results = await Promise.all(builds.map((options) => build({ ...options, metafile: true })))
  await mkdir('.cache', { recursive: true })
  await writeFile(
    '.cache/build-meta.json',
    JSON.stringify(results.map((result) => result.metafile)),
  )
}
