import { AuthStateStore } from '../../src/storage/store.ts'

const [mode, profile, stage] = process.argv.slice(2)
if (!profile) throw new Error('profile required')

if (mode === 'hold') {
  const store = await AuthStateStore.open(profile)
  process.stdout.write('READY\n')
  process.stdin.resume()
  process.stdin.on('end', () => void store.close().then(() => process.exit(0)))
} else if (mode === 'crash') {
  const store = await AuthStateStore.open(profile, {
    onStage(reached) {
      if (reached === stage) process.exit(77)
    },
  })
  await store.transact((draft) => {
    draft.account = {
      id: 'c'.repeat(32),
      username: 'child',
      password: { salt: 'b'.repeat(64), hash: 'd'.repeat(128) },
      totp: null,
      securityVersion: 1,
    }
  })
  await store.close()
  process.stdout.write('SUCCESS\n')
} else {
  throw new Error('unknown child mode')
}
