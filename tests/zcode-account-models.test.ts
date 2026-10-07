import { afterEach, expect, it, vi } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverZCode, prepareZCode } from '../src/host/zcode-adapter.ts'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { projectZCodeIdentity } from '../src/host/zcode-grok-accounts.ts'

// Explicit synthetic account bindings and HTTP responses. No user account/network/model call.
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const provider = 'account:bigmodel-individual-coding-plan'
const secret = 'SYNTHETIC_CIPHER_SECRET'
function fixture(selectedProvider = provider) {
  const root = mkdtempSync(join(tmpdir(), 'cwn-zcode-account-models-'))
  roots.push(root)
  const auth = join(root, 'auth'),
    credentials = join(auth, '.zcode/v2/credentials.json'),
    builtin = join(root, 'builtin.json')
  mkdirSync(join(auth, '.zcode/v2'), { recursive: true })
  const config: any = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: selectedProvider,
            config: {
              access: {
                type: 'zhipu-account',
                accountType: 'bigmodel',
                mode: 'individual-coding-plan',
                entitled: true,
              },
              api: { type: 'openai-chat-completions', baseUrl: 'https://fixture.test/v1' },
              builtinModelIds: ['supported', 'not-in-account'],
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [
          {
            modelMatch: '.*',
            config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } },
          },
        ],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  }
  writeFileSync(builtin, JSON.stringify(config))
  const save = (values: Record<string, string>) => {
    const raw = Object.fromEntries(
      Object.entries(values).map(([name, value]) => {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
        const body = Buffer.concat([cipher.update(value), cipher.final()])
        return [
          name,
          `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`,
        ]
      }),
    )
    writeFileSync(credentials, JSON.stringify(raw), { mode: 0o600 })
    return raw
  }
  const values = {
    [`account-provider:${selectedProvider}:identity`]: 'current/identity',
    [`account-provider:coding-plan:${selectedProvider}:account:current%2Fidentity:api-key`]:
      'SYNTHETIC_CURRENT_KEY',
    [`account-provider:coding-plan:${selectedProvider}:account:old:api-key`]: 'SYNTHETIC_OLD_KEY',
  }
  const query = (fetcher: typeof fetch) =>
    discoverZCode('/synthetic/zcode', vi.fn(), join(root, 'query'), auth, builtin, {
      nativeHome: join(root, 'empty-home'),
      credentialSecret: secret,
      probeOptions: { fetch: fetcher },
    })
  return { root, auth, credentials, builtin, config, save, values, query }
}
it('uses the exact native account binding and API origin, keeping only the account model intersection', async () => {
  const f = fixture(),
    raw = f.save(f.values),
    before = readFileSync(f.credentials)
  const fetcher = vi.fn(async (url: any, options: any) => {
    expect(url).toBe('https://fixture.test/v1/models')
    expect(options.headers.Authorization).toBe('Bearer SYNTHETIC_CURRENT_KEY')
    expect(options.method).toBe('GET')
    return new Response(JSON.stringify({ data: [{ id: 'supported', free: true }, { id: 'public-only' }] }))
  })
  expect(await f.query(fetcher)).toEqual([
    {
      id: `${provider}/supported`,
      label: `supported（${provider} · 本机目录）`,
      efforts: ['low', 'high'],
      cost: 'unknown',
    },
  ])
  expect(projectZCodeIdentity(raw, secret)).toMatchObject({ state: 'configured', verification: 'local' })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(readFileSync(f.credentials)).toEqual(before)
})
it('keeps Host decryption and resumed/headless native execution on the same environment cipher secret', async () => {
  const f = fixture()
  f.save(f.values)
  vi.stubEnv('ZCODE_CREDENTIAL_SECRET', ` ${secret} `)
  expect(scrubbedParentEnv().ZCODE_CREDENTIAL_SECRET).toBeUndefined()
  const before = readFileSync(f.credentials)
  const models = await discoverZCode('/synthetic/zcode', vi.fn(), join(f.root, 'query'), f.auth, f.builtin, {
    nativeHome: join(f.root, 'empty-home'),
    probeOptions: {
      fetch: async (_url, options) => {
        expect((options!.headers as Record<string, string>).Authorization).toBe(
          'Bearer SYNTHETIC_CURRENT_KEY',
        )
        return new Response(JSON.stringify({ data: [{ id: 'supported' }] }))
      },
    },
  })
  expect(models.map((model) => model.id)).toEqual([`${provider}/supported`])
  expect(JSON.stringify(models)).not.toContain(secret)
  for (const conversationId of [undefined, 'synthetic-session']) {
    const launch = await prepareZCode({
      executable: '/synthetic/zcode',
      project: f.root,
      prompt: 'Synthetic task; never executed',
      stateDirectory: join(f.root, conversationId ? 'resumed' : 'headless'),
      authDirectory: f.auth,
      nativeHome: join(f.root, 'empty-home'),
      builtinConfig: f.builtin,
      preference: { model: models[0]!.id, effort: 'low' },
      mode: 'plan',
      conversationId,
    })
    expect({ ...scrubbedParentEnv(), ...launch.env }.ZCODE_CREDENTIAL_SECRET).toBe(secret)
    expect(JSON.stringify(launch.argv)).not.toContain(secret)
    expect(readFileSync(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).not.toContain(secret)
    if (conversationId) expect(readFileSync(launch.argv[2]!, 'utf8')).not.toContain(secret)
  }
  expect(readFileSync(f.credentials)).toEqual(before)
})
it('mirrors native Anthropic authentication while keeping custom endpoints case-sensitive and credentials private', async () => {
  const f = fixture()
  f.save(f.values)
  const native = f.config.config.providerConfigRules.providerRules[0].config
  native.api = { type: 'anthropic-messages', baseUrl: 'https://fixture.test/anthropic' }
  native.builtinModelIds = ['GLM-5.3', 'GLM-5.3-Flash']
  writeFileSync(f.builtin, JSON.stringify(f.config))
  const before = readFileSync(f.credentials)
  const fetcher = vi.fn(async (url: any, options: any) => {
    expect(url).toBe('https://fixture.test/anthropic/v1/models')
    expect(options.method).toBe('GET')
    expect(options.redirect).toBe('error')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer SYNTHETIC_CURRENT_KEY',
      'x-api-key': 'SYNTHETIC_CURRENT_KEY',
      'anthropic-version': '2023-06-01',
    })
    return new Response(
      JSON.stringify({
        data: [
          { id: 'GLM-5.3' },
          { id: 'glm-5.3-flash' },
          { id: 'SYNTHETIC_CURRENT_KEY' },
          { id: 'public-only' },
        ],
      }),
    )
  })
  const result = await f.query(fetcher)
  expect(result.map((model) => model.id)).toEqual([`${provider}/GLM-5.3`])
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_CURRENT_KEY')
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(readFileSync(f.credentials)).toEqual(before)
})
// The 11 IDs were recorded by the authorized read-only query on 2026-10-08.
// All response envelopes, credentials and transports below are explicitly simulated.
const observedOfficialIds = [
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5-turbo',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.3-flashx',
]
it.each([
  ['bigmodel', 'https://open.bigmodel.cn/api/anthropic'],
  ['zai', 'https://api.z.ai/api/anthropic'],
])(
  'projects verified official %s GLM aliases to the unchanged native execution IDs',
  async (accountType, baseUrl) => {
    const nativeProvider = `account:${accountType}-individual-coding-plan`
    const f = fixture(nativeProvider)
    f.save(f.values)
    const native = f.config.config.providerConfigRules.providerRules[0].config
    native.access.accountType = accountType
    native.api = { type: 'anthropic-messages', baseUrl }
    native.builtinModelIds = ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-FlashX', 'GLM-5.3-Flash-Pro']
    writeFileSync(f.builtin, JSON.stringify(f.config))
    const before = readFileSync(f.credentials)
    const fetcher = vi.fn(async (url: any, options: any) => {
      expect(url).toBe(`${baseUrl}/v1/models`)
      expect(options.headers.Authorization).toBe('Bearer SYNTHETIC_CURRENT_KEY')
      expect(options.headers['x-api-key']).toBe('SYNTHETIC_CURRENT_KEY')
      return new Response(JSON.stringify({ data: observedOfficialIds.map((id) => ({ id })) }))
    })
    const models = await f.query(fetcher)
    expect(models.map((model) => model.id)).toEqual([
      `${nativeProvider}/GLM-5.3`,
      `${nativeProvider}/GLM-5.3-Flash`,
    ])
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.stringify(models)).not.toContain('SYNTHETIC_CURRENT_KEY')
    for (const model of models) {
      const launch = await prepareZCode({
        executable: '/synthetic/zcode',
        project: f.root,
        prompt: 'Synthetic; never executed',
        stateDirectory: join(f.root, model.id.endsWith('-Flash') ? 'flash' : 'base'),
        authDirectory: f.auth,
        nativeHome: join(f.root, 'empty-home'),
        builtinConfig: f.builtin,
        preference: { model: model.id, effort: 'high' },
        mode: 'plan',
      })
      expect(
        JSON.parse(readFileSync(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config
          .defaultModelSelection,
      ).toEqual({
        providerId: nativeProvider,
        modelId: model.id.split('/')[1],
        options: { reasoningLevel: 'high' },
      })
    }
    expect(readFileSync(f.credentials)).toEqual(before)
  },
)
it.each([
  { reason: 'another provider', providerId: 'account:other-individual-coding-plan' },
  { reason: 'a custom endpoint', baseUrl: 'https://fixture.test/anthropic' },
  { reason: 'the other official endpoint', baseUrl: 'https://api.z.ai/api/anthropic' },
  { reason: 'a different account type', accountType: 'zai' },
  { reason: 'an explicit API-key route', accessType: 'api-key' },
  { reason: 'another API protocol', apiType: 'openai-chat-completions' },
])('does not apply official aliases to $reason', async (scope) => {
  const f = fixture(scope.providerId ?? provider)
  f.save(f.values)
  const native = f.config.config.providerConfigRules.providerRules[0].config
  native.api = {
    type: scope.apiType ?? 'anthropic-messages',
    baseUrl: scope.baseUrl ?? 'https://open.bigmodel.cn/api/anthropic',
  }
  native.builtinModelIds = ['GLM-5.3', 'GLM-5.3-Flash']
  if (scope.accountType) native.access.accountType = scope.accountType
  if (scope.accessType) native.access = { type: scope.accessType, apiKey: 'SYNTHETIC_CURRENT_KEY' }
  writeFileSync(f.builtin, JSON.stringify(f.config))
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ data: observedOfficialIds.map((id) => ({ id })) })),
  )
  expect(await f.query(fetcher)).toEqual([])
  expect(fetcher).toHaveBeenCalledOnce()
})
it('does not interpret a similar official suffix as an entitled native model', async () => {
  const f = fixture()
  f.save(f.values)
  const native = f.config.config.providerConfigRules.providerRules[0].config
  native.api = { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }
  native.builtinModelIds = ['GLM-5.3-Flash']
  writeFileSync(f.builtin, JSON.stringify(f.config))
  expect(
    await f.query(async () => new Response(JSON.stringify({ data: [{ id: 'glm-5.3-flashx' }] }))),
  ).toEqual([])
})
it('does not fall back to an old identity key, OAuth access or refresh token', async () => {
  const f = fixture()
  const { [`account-provider:coding-plan:${provider}:account:current%2Fidentity:api-key`]: _, ...values } =
    f.values
  f.save({
    ...values,
    'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:access_token': 'SYNTHETIC_OAUTH',
    'oauth:bigmodel:refresh_token': 'SYNTHETIC_REFRESH',
  })
  const fetcher = vi.fn()
  expect(await f.query(fetcher)).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})
it.each([401, 403, 404])(
  'does not replace account metadata rejection %s with static entitled flags',
  async (status) => {
    const f = fixture()
    f.save(f.values)
    expect(await f.query(async () => new Response('', { status }))).toEqual([])
  },
)
it('supports an explicit native API route without treating configured models as account scope', async () => {
  const f = fixture()
  f.config.config.providerConfigRules.providerRules[0].config.access = {
    type: 'api-key',
    apiKey: 'SYNTHETIC_API_KEY',
  }
  writeFileSync(f.builtin, JSON.stringify(f.config))
  const fetcher = vi.fn(async (_url: any, options: any) => {
    expect(options.headers.Authorization).toBe('Bearer SYNTHETIC_API_KEY')
    return new Response(JSON.stringify({ data: [{ id: 'supported' }] }))
  })
  expect((await f.query(fetcher)).map((model) => model.id)).toEqual([`${provider}/supported`])
  expect(await f.query(async () => new Response(JSON.stringify({ data: [] })))).toEqual([])
})
it('keeps unknown native access modes and credential-altering headers out of the probe', async () => {
  const f = fixture()
  f.save(f.values)
  f.config.config.providerConfigRules.providerRules[0].config.api.headers = {
    Authorization: 'SYNTHETIC_OTHER_ACCOUNT',
  }
  writeFileSync(f.builtin, JSON.stringify(f.config))
  const fetcher = vi.fn()
  expect(await f.query(fetcher)).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})
