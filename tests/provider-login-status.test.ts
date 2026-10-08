import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspectPiOmpNativeAccount } from '../src/host/pi-omp-native.ts'
import {
  inspectOpenCodeProfile,
  snapshotOpenCodeAuth,
  OPENCODE_OAUTH_UNSUPPORTED,
} from '../src/host/opencode-native.ts'

// All credentials, account homes and API endpoints below are synthetic. No CLI is run.
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture(cli: 'pi' | 'omp' | 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'cwn-provider-login-'))
  roots.push(root)
  const state = join(root, 'state'),
    global = join(root, `.${cli}`, 'agent')
  const own = join(state, 'accounts', cli, 'agent'),
    data = join(state, 'accounts/opencode/data')
  for (const dir of [global, own, join(data, 'opencode'), join(root, '.config/opencode')])
    await mkdir(dir, { recursive: true, mode: 0o700 })
  const status = () =>
    cli === 'opencode'
      ? inspectOpenCodeProfile(data, { nativeHome: root })
      : inspectPiOmpNativeAccount(cli, state, new AbortController().signal, { nativeHome: root })
  return { root, global, own, data, status }
}
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 })
function database(
  path: string,
  rows: { provider: string; type: string; data: unknown; disabled?: string }[],
) {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE auth_credentials(provider TEXT,credential_type TEXT,data TEXT,disabled_cause TEXT)')
    for (const row of rows)
      db.prepare('INSERT INTO auth_credentials VALUES(?,?,?,?)').run(
        row.provider,
        row.type,
        JSON.stringify(row.data),
        row.disabled ?? null,
      )
  } finally {
    db.close()
  }
}
const oauth = (extra = {}) => ({
  type: 'oauth',
  access: 'synthetic-access',
  refresh: 'synthetic-refresh',
  expires: Date.now() + 60000,
  ...extra,
})

describe('Pi and OMP own provider login projection', () => {
  it('shows Pi API and account logins separately without disclosing credentials or account fields', async () => {
    const f = await fixture('pi'),
      path = join(f.own, 'auth.json')
    await save(path, {
      'zai-coding-cn': { type: 'api_key', key: 'synthetic-key' },
      'openai-codex': oauth({ accountId: 'private-account', email: 'private@example.test' }),
    })
    const before = await readFile(path)
    const status = await f.status()
    expect(status).toMatchObject({
      state: 'authenticated',
      verification: 'local',
      logins: [
        { providerLabel: 'zai.cn', authMethod: 'api' },
        { providerLabel: 'OpenAI', authMethod: 'oauth' },
      ],
    })
    expect(status.authMethod).toBeUndefined()
    expect(JSON.stringify(status)).not.toMatch(/synthetic|private|accountId|@/)
    expect(await readFile(path)).toEqual(before)
  })
  it('projects the merged source, never the superseded global account or an old worker', async () => {
    const f = await fixture('pi')
    await save(join(f.global, 'auth.json'), { openai: { type: 'api_key', key: 'synthetic-global' } })
    await save(join(f.own, 'auth.json'), { openai: oauth({ expires: 1, refresh: '' }) })
    expect(await f.status()).toMatchObject({ state: 'unauthenticated' })
    expect((await f.status()).logins).toBeUndefined()
    await save(join(f.global, 'auth.json'), {})
    await save(join(f.own, 'auth.json'), {})
    await mkdir(join(f.root, 'worker'))
    await save(join(f.root, 'worker/auth.json'), { openai: { type: 'api_key', key: 'synthetic-old-worker' } })
    expect((await f.status()).state).toBe('unconfigured')
  })
  it.each(['pi', 'omp'] as const)(
    '%s needs its own resolved provider credential, not model declarations, templates or parent environment',
    async (cli) => {
      const f = await fixture(cli),
        model = cli === 'pi' ? 'models.json' : 'models.yml'
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-other-cli')
      await save(join(f.own, model), {
        providers: { openai: { apiKey: 'OPENAI_API_KEY', models: [{ id: 'public-model' }] } },
      })
      expect((await f.status()).state).toBe('configured')
      await writeFile(join(f.own, '.env'), 'OPENAI_API_KEY=YOUR_API_KEY\n')
      expect((await f.status()).state).toBe('configured')
      await writeFile(join(f.own, '.env'), 'OPENAI_API_KEY=synthetic-own-key\n')
      expect(await f.status()).toMatchObject({
        state: 'authenticated',
        authMethod: 'api',
        logins: [{ providerLabel: 'OpenAI', authMethod: 'api' }],
      })
    },
  )
  it('shows OMP own API and active OAuth while excluding a disabled OAuth row', async () => {
    const f = await fixture('omp'),
      path = join(f.global, 'agent.db')
    database(path, [
      { provider: 'github-copilot', type: 'oauth', data: oauth({ expires: 1 }), disabled: 'revoked' },
      { provider: 'openai-codex', type: 'oauth', data: oauth() },
    ])
    await save(join(f.own, 'models.yml'), {
      providers: {
        own: { apiKey: 'OWN_API_KEY', baseUrl: 'OWN_API_BASE', models: [{ id: 'synthetic-model' }] },
      },
    })
    await writeFile(
      join(f.own, '.env'),
      'OWN_API_KEY=synthetic-own-key\nOWN_API_BASE=https://open.bigmodel.cn/api/coding/paas/v4\n',
    )
    const before = await readFile(path),
      status = await f.status()
    expect(status).toMatchObject({
      state: 'authenticated',
      logins: [
        { providerLabel: 'OpenAI', authMethod: 'oauth' },
        { providerLabel: 'zai.cn', authMethod: 'api' },
      ],
    })
    expect(status.authMethod).toBeUndefined()
    expect(await readFile(path)).toEqual(before)
  })
  it('keeps disabled-only OMP red and accepts a current native API row', async () => {
    const f = await fixture('omp'),
      path = join(f.own, 'agent.db')
    database(path, [{ provider: 'openai-codex', type: 'oauth', data: oauth(), disabled: 'revoked' }])
    expect((await f.status()).state).toBe('unauthenticated')
    await rm(path)
    database(path, [{ provider: 'zai-coding-cn', type: 'api_key', data: { key: 'synthetic-own-key' } }])
    expect(await f.status()).toMatchObject({
      state: 'authenticated',
      authMethod: 'api',
      logins: [{ providerLabel: 'zai.cn', authMethod: 'api' }],
    })
  })
})

describe('OpenCode own provider login projection', () => {
  it('shows native API login and does not use public models to infer another login', async () => {
    const f = await fixture('opencode'),
      path = join(f.data, 'opencode/auth.json')
    await save(path, { 'zhipuai-coding-plan': { type: 'api', key: 'synthetic-own-key' } })
    await mkdir(join(f.root, '.cache/opencode'), { recursive: true })
    await save(join(f.root, '.cache/opencode/models.json'), { openai: { models: { 'public-model': {} } } })
    const before = await readFile(path)
    expect(await f.status()).toMatchObject({
      state: 'authenticated',
      authMethod: 'api',
      logins: [{ providerLabel: 'zai.cn', authMethod: 'api' }],
    })
    expect(await readFile(path)).toEqual(before)
  })
  it('recognizes native renewable OAuth for display without relaxing unsupported OAuth execution', async () => {
    const f = await fixture('opencode'),
      path = join(f.data, 'opencode/auth.json')
    const auth = { openai: oauth({ expires: 1 }) }
    await save(path, auth)
    expect(await f.status()).toMatchObject({
      state: 'authenticated',
      authMethod: 'oauth',
      logins: [{ providerLabel: 'OpenAI', authMethod: 'oauth' }],
    })
    await expect(snapshotOpenCodeAuth(f.data, auth, ['openai'])).rejects.toThrow(OPENCODE_OAUTH_UNSUPPORTED)
    await save(path, { openai: oauth({ expires: 1, refresh: '' }) })
    expect((await f.status()).state).toBe('unauthenticated')
    await save(path, { openai: oauth({ access: '', refresh: 'synthetic-refresh', expires: 1 }) })
    expect((await f.status()).state).not.toBe('authenticated')
  })
  it('requires a resolved own API config and retains mixed provider methods', async () => {
    const f = await fixture('opencode'),
      config = join(f.root, '.config/opencode/opencode.json')
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-parent-key')
    await save(config, {
      provider: {
        custom: { options: { apiKey: '{env:OPENAI_API_KEY}', baseURL: 'https://models.test/private' } },
      },
    })
    expect((await f.status()).state).toBe('configured')
    await writeFile(join(f.root, '.config/opencode/.env'), 'OPENAI_API_KEY=synthetic-own-key\n')
    await save(join(f.data, 'opencode/auth.json'), { anthropic: oauth() })
    const status = await f.status()
    expect(status).toMatchObject({
      state: 'authenticated',
      logins: [
        { providerLabel: 'Anthropic', authMethod: 'oauth' },
        { providerLabel: 'models.test', authMethod: 'api' },
      ],
    })
    expect(status.authMethod).toBeUndefined()
    expect(JSON.stringify(status)).not.toMatch(/synthetic|private/)
  })
  it('leaves API templates configured and absence unconfigured', async () => {
    const f = await fixture('opencode'),
      path = join(f.data, 'opencode/auth.json')
    expect((await f.status()).state).toBe('unconfigured')
    await save(path, { openai: { type: 'api', key: 'YOUR_API_KEY' } })
    expect((await f.status()).state).toBe('configured')
    await save(path, { openai: { type: 'future', key: 'synthetic-key' } })
    expect((await f.status()).state).toBe('unknown')
    await writeFile(path, '{invalid')
    expect((await f.status()).state).toBe('unavailable')
  })
})
