import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { accountSupportedChoices } from '../src/host/pi-native-catalog.mjs'
// Explicitly simulated account metadata; no global home, OAuth, network or model call.
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const rows = [
  { provider: 'openai-codex', id: 'common', name: 'Common', reasoning: false },
  { provider: 'openai-codex', id: 'wide-only', name: 'Wide', reasoning: false },
]
const credential = (access: string, expires = Date.now() + 3600000) => ({ type: 'oauth', access, expires })
async function fixture(
  cli: 'pi' | 'omp',
  auth: any[],
  settings: { provider?: string; configKey?: string; baseUrl?: string } = {},
) {
  const provider = settings.provider ?? 'openai-codex'
  const root = await mkdtemp(join(tmpdir(), 'cwn-account-scope-fixture-'))
  roots.push(root)
  const path = join(root, 'agent')
  await mkdir(path, { mode: 0o700 })
  await writeFile(
    join(path, cli === 'pi' ? 'models.json' : 'models.yml'),
    JSON.stringify({
      providers: {
        [provider]: {
          ...(settings.configKey ? { apiKey: settings.configKey } : {}),
          baseUrl: settings.baseUrl ?? 'https://chatgpt.com/backend-api',
        },
      },
    }),
    { mode: 0o600 },
  )
  if (cli === 'pi')
    await writeFile(join(path, 'auth.json'), JSON.stringify(auth.length ? { [provider]: auth[0] } : {}), {
      mode: 0o600,
    })
  else {
    const db = new DatabaseSync(join(path, 'agent.db'))
    db.exec(
      'CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)',
    )
    for (const entry of auth)
      db.prepare('INSERT INTO auth_credentials VALUES (?,?,?,NULL)').run(
        provider,
        entry.type,
        JSON.stringify(entry),
      )
    db.close()
  }
  return path
}
const response = (payload: unknown) =>
  new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
const metadata = (scopes: Record<string, { ids: string[]; plan: string }>) =>
  vi.fn(async (url: unknown, options: any) => {
    const token = options.headers.Authorization.replace('Bearer ', '')
    const scope = scopes[token]
    expect(scope).toBeDefined()
    return String(url).includes('/usage')
      ? response({ plan_type: scope.plan, rate_limit: { allowed: true, limit_reached: false } })
      : response({ models: scope.ids.map((slug) => ({ slug, supported_in_api: true })) })
  })
it.each(['pi', 'omp'] as const)(
  '%s respects native OAuth priority rather than a wider API env identity',
  async (cli) => {
    const token = 'SYNTHETIC_OAUTH_NARROW'
    const path = await fixture(cli, [credential(token)])
    const fetcher = metadata({ [token]: { ids: ['common'], plan: 'plus' } })
    const choices = await accountSupportedChoices(
      cli,
      path,
      rows,
      { TEST_API_KEY: 'SYNTHETIC_API_WIDE' },
      { fetch: fetcher },
    )
    expect(choices.map((model: any) => [model.id, model.cost])).toEqual([['openai-codex/common', 'paid']])
    expect(JSON.stringify(choices)).not.toContain(token)
  },
)
it('OMP intersects every possible active account and does not mark an any-free pool free', async () => {
  const one = 'SYNTHETIC_FREE_ACCOUNT',
    two = 'SYNTHETIC_PAID_ACCOUNT'
  const path = await fixture('omp', [credential(one), credential(two)])
  const fetcher = metadata({
    [one]: { ids: ['common', 'wide-only'], plan: 'free' },
    [two]: { ids: ['common'], plan: 'plus' },
  })
  const choices = await accountSupportedChoices('omp', path, rows, {}, { fetch: fetcher })
  expect(choices.map((model: any) => [model.id, model.cost])).toEqual([['openai-codex/common', 'paid']])
})
it('OMP declares free only when every possible account supports the model with free quota', async () => {
  const one = 'SYNTHETIC_FREE_ONE',
    two = 'SYNTHETIC_FREE_TWO'
  const path = await fixture('omp', [credential(one), credential(two)])
  const fetcher = metadata({
    [one]: { ids: ['common'], plan: 'free' },
    [two]: { ids: ['common'], plan: 'free' },
  })
  const choices = await accountSupportedChoices('omp', path, rows, {}, { fetch: fetcher })
  expect(choices[0]?.cost).toBe('free')
})
it('does not replace an expired native login with a wider env account or refresh the token', async () => {
  const path = await fixture('pi', [credential('SYNTHETIC_EXPIRED_ACCOUNT', 1)])
  const fetcher = vi.fn()
  const choices = await accountSupportedChoices(
    'pi',
    path,
    rows,
    { TEST_API_KEY: 'SYNTHETIC_API_WIDE' },
    { fetch: fetcher },
  )
  expect(choices).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})

it('OMP explicit config API key wins over an OAuth broker identity', async () => {
  const path = await fixture('omp', [credential('SYNTHETIC_OAUTH_NARROW')], {
    configKey: 'TEST_API_KEY',
    baseUrl: 'https://proxy.test/v1',
  })
  const fetcher = metadata({ SYNTHETIC_API_WIDE: { ids: ['common', 'wide-only'], plan: 'unknown' } })
  const choices = await accountSupportedChoices(
    'omp',
    path,
    rows,
    { TEST_API_KEY: 'SYNTHETIC_API_WIDE' },
    { fetch: fetcher },
  )
  expect(choices.map((model: any) => model.id)).toEqual(['openai-codex/common', 'openai-codex/wide-only'])
})
it('Pi stored API wins over configured API and default env', async () => {
  const path = await fixture('pi', [{ type: 'api', key: 'SYNTHETIC_STORED_NARROW' }], {
    provider: 'openai',
    configKey: 'TEST_API_KEY',
    baseUrl: 'https://proxy.test/v1',
  })
  const fetcher = metadata({ SYNTHETIC_STORED_NARROW: { ids: ['common'], plan: 'unknown' } })
  const candidates = rows.map((model) => ({ ...model, provider: 'openai' }))
  const choices = await accountSupportedChoices(
    'pi',
    path,
    candidates,
    { TEST_API_KEY: 'SYNTHETIC_CONFIG_WIDE', OPENAI_API_KEY: 'SYNTHETIC_ENV_WIDE' },
    { fetch: fetcher },
  )
  expect(choices.map((model: any) => model.id)).toEqual(['openai/common'])
})
it('OMP login API wins over default env rather than a stale static credential', async () => {
  const path = await fixture('omp', [{ type: 'api_key', source: 'login', key: 'SYNTHETIC_LOGIN_NARROW' }], {
    provider: 'openai',
    baseUrl: 'https://proxy.test/v1',
  })
  const fetcher = metadata({ SYNTHETIC_LOGIN_NARROW: { ids: ['common'], plan: 'unknown' } })
  const candidates = rows.map((model) => ({ ...model, provider: 'openai' }))
  const choices = await accountSupportedChoices(
    'omp',
    path,
    candidates,
    { OPENAI_API_KEY: 'SYNTHETIC_ENV_WIDE' },
    { fetch: fetcher },
  )
  expect(choices.map((model: any) => model.id)).toEqual(['openai/common'])
})
it('does not redirect a model-specific proxy key to the default provider origin or echo it in a label', async () => {
  const key = 'SYNTHETIC_PROXY_ONLY_KEY'
  const path = await fixture('pi', [{ type: 'api', key }], {
    provider: 'openai',
    baseUrl: 'https://unused-provider.test/v1',
  })
  const seen: string[] = []
  const choices = await accountSupportedChoices(
    'pi',
    path,
    [
      {
        provider: 'openai',
        id: 'custom',
        name: key,
        baseUrl: 'https://specific-model.test/v1',
        api: 'openai-completions',
      },
    ],
    {},
    {
      fetch: async (url: unknown) => {
        seen.push(String(url))
        return response({ data: [{ id: 'custom' }] })
      },
    },
  )
  expect(seen).toEqual(['https://specific-model.test/v1/models'])
  expect(choices[0]?.label).toBe('custom')
  expect(JSON.stringify(choices)).not.toContain(key)
})

it('conservatively hides models with unverified native credential/scope header overrides', async () => {
  const path = await fixture('pi', [{ type: 'api', key: 'SYNTHETIC_STORED_KEY' }], {
    provider: 'openai',
    baseUrl: 'https://proxy.test/v1',
  })
  const fetcher = vi.fn()
  const choices = await accountSupportedChoices(
    'pi',
    path,
    [
      {
        provider: 'openai',
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://proxy.test/v1',
        headers: { Authorization: 'Bearer SYNTHETIC_OTHER_IDENTITY' },
      },
    ],
    {},
    { fetch: fetcher },
  )
  expect(choices).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})
