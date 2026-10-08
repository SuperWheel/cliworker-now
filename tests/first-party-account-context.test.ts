import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMimoAccount } from '../src/host/mimo-configuration.ts'
import { prepareMimoAccountTerminal } from '../src/host/first-party-account-context.ts'
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
async function fixture(auth?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'cwn-mimo-account-'))
  roots.push(root)
  vi.stubEnv('MIMOCODE_HOME', join(root, 'native'))
  const data = join(root, 'native/data')
  await mkdir(data, { recursive: true })
  if (auth !== undefined) await writeFile(join(data, 'auth.json'), JSON.stringify(auth))
  return { root, data }
}
describe('MiMo own native account context (synthetic files only)', () => {
  it('recognizes the native browser-login ApiAuth without exposing private fields or loading project config', async () => {
    const f = await fixture({
      xiaomi: {
        type: 'api',
        key: 'synthetic-secret',
        metadata: { uid: 'private-user', base_url: 'https://example.invalid/v1' },
      },
    })
    await mkdir(join(f.root, 'native/config'))
    await writeFile(join(f.root, 'native/config/mimocode.json'), 'invalid {file:~/.codex/auth.json}')
    const status = await readMimoAccount(signal())
    expect(status).toMatchObject({ state: 'authenticated', authMethod: 'api', verification: 'local' })
    expect(JSON.stringify(status)).not.toMatch(/synthetic-secret|private-user|example.invalid/)
    await rm(join(f.data, 'auth.json'))
    expect(await readMimoAccount(signal())).toMatchObject({ state: 'unconfigured' })
  })
  it('does not treat ambient credentials, other providers, or empty keys as a MiMo login', async () => {
    vi.stubEnv('MIMOCODE_AUTH_CONTENT', JSON.stringify({ xiaomi: { type: 'api', key: 'ambient' } }))
    await fixture({ openai: { type: 'api', key: 'own-other-provider' } })
    expect(await readMimoAccount(signal())).toMatchObject({ state: 'unconfigured' })
    const f = await fixture({ xiaomi: { type: 'api', key: '' } })
    expect(await readMimoAccount(signal())).toMatchObject({ state: 'configured' })
    await rm(join(f.data, 'auth.json'))
    await symlink(join(f.root, 'foreign.json'), join(f.data, 'auth.json'))
    await expect(readMimoAccount(signal())).rejects.toThrow('来源无法确认')
  })
  it('uses the same live native store for login/logout, isolates configuration, and removes only the temporary context', async () => {
    const f = await fixture({ xiaomi: { type: 'api', key: 'synthetic-old' } })
    const prepared = await prepareMimoAccountTerminal(
      '/synthetic/mimo',
      'login',
      join(f.root, 'state'),
      signal(),
    )
    const path = join(prepared.env.MIMOCODE_HOME, 'data/auth.json')
    expect(await readlink(path)).toBe(join(f.data, 'auth.json'))
    expect(prepared.argv).toEqual(['/synthetic/mimo', 'auth', 'login'])
    expect(prepared.env).toMatchObject({
      MIMOCODE_AUTH_CONTENT: '',
      MIMOCODE_DISABLE_PROJECT_CONFIG: '1',
      MIMOCODE_PURE: '1',
    })
    // Simulate native Auth.set's writeFileString, including a subsequent logout.
    await writeFile(path, JSON.stringify({ xiaomi: { type: 'api', key: 'synthetic-new' } }))
    expect(JSON.parse(await readFile(join(f.data, 'auth.json'), 'utf8')).xiaomi.key).toBe('synthetic-new')
    await writeFile(path, '{}')
    expect(await readMimoAccount(signal())).toMatchObject({ state: 'unconfigured' })
    await prepared.cleanup()
    expect(existsSync(prepared.cwd)).toBe(false)
    expect(await readFile(join(f.data, 'auth.json'), 'utf8')).toBe('{}')
  })
  it('does not start remote wellknown configuration or prepare a cancelled login', async () => {
    const f = await fixture({
      'https://foreign.invalid': { type: 'wellknown', key: 'TOKEN', token: 'synthetic' },
    })
    await expect(
      prepareMimoAccountTerminal('/synthetic/mimo', 'login', join(f.root, 'state'), signal()),
    ).rejects.toThrow('远程配置')
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      prepareMimoAccountTerminal('/synthetic/mimo', 'login', join(f.root, 'state'), cancelled.signal),
    ).rejects.toThrow()
  })
})
