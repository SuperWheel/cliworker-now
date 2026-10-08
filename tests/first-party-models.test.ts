import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverFirstPartySources,
  firstPartyEnvironment,
  mimoModelSources,
  parseKimiModelSources,
  parseMimoModelRecords,
  readFirstPartyModelSources,
} from '../src/host/first-party-models.ts'
import { workerArguments } from '../src/host/adapters.ts'

// All identities, configurations, subprocess replies, and HTTP responses are synthetic.
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
const kimi = (provider: Record<string, unknown> = {}) => ({
  providers: {
    own: { type: 'kimi', baseUrl: 'https://kimi.example.test/v1', apiKey: 'synthetic-kimi-key', ...provider },
  },
  models: {
    alias: { provider: 'own', model: 'permitted-model', protocol: 'anthropic' },
    public: { provider: 'own', model: 'not-entitled', protocol: 'anthropic' },
  },
})
const mimo = (extra: Record<string, unknown> = {}) => ({
  id: 'native-model',
  providerID: 'own',
  name: 'Synthetic MiMo',
  api: { id: 'upstream-model', npm: '@ai-sdk/anthropic', url: 'https://mimo.example.test/v1' },
  variants: { high: {}, impossible: {}, low: { disabled: true } },
  ...extra,
})
const fetchModels = (ids: string[], status = 200) =>
  vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status }),
  )

describe('first-party model scopes', () => {
  it('intersects Kimi native aliases with its own API scope and shares one readonly request', async () => {
    const sources = parseKimiModelSources(kimi(), '/synthetic/kimi/config.toml'),
      fetch = fetchModels(['permitted-model', 'server-only'])
    expect(await discoverFirstPartySources(sources, signal(), { fetch })).toEqual([
      { id: 'alias', label: 'alias', efforts: ['default'], cost: 'unknown' },
    ])
    expect(fetch).toHaveBeenCalledOnce()
    const [url, options] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://kimi.example.test/v1/models')
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-kimi-key')
    expect(options?.method ?? 'GET').toBe('GET')
  })
  it.each([
    { apiKey: '' },
    { apiKey: '{env:OPENAI_API_KEY}' },
    { apiKey: '$OPENAI_API_KEY' },
    { apiKey: '!cat ~/.codex/auth.json' },
    { oauth: { key: 'other-cli' } },
    { customHeaders: { Authorization: 'foreign' } },
  ])('does not infer Kimi permission from ambient/foreign material: %j', (provider) => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-secret')
    expect(parseKimiModelSources(kimi(provider), '/synthetic/kimi')).toEqual([])
  })
  it('allows Kimi config-file private env but never substitutes process env', () => {
    expect(
      parseKimiModelSources(kimi({ apiKey: undefined, env: { KIMI_API_KEY: 'own-literal' } }), '/synthetic')
        .length,
    ).toBe(2)
    vi.stubEnv('KIMI_API_KEY', 'ambient')
    expect(parseKimiModelSources(kimi({ apiKey: undefined }), '/synthetic')).toEqual([])
  })
  it('denial and unknown catalogue errors remove every configured candidate', async () => {
    const sources = parseKimiModelSources(kimi(), '/synthetic')
    for (const status of [401, 403, 404, 500])
      expect(
        await discoverFirstPartySources(sources, signal(), {
          fetch: fetchModels(['permitted-model'], status),
        }),
      ).toEqual([])
  })
  it('MiMo uses its own native auth plus exact remote ID and real variants', async () => {
    const sources = mimoModelSources(
      [mimo()],
      {},
      { own: { type: 'api', key: 'synthetic-mimo-key' } },
      '/synthetic/mimocode/auth.json',
    )
    const fetch = fetchModels(['upstream-model'])
    expect(await discoverFirstPartySources(sources, signal(), { fetch })).toEqual([
      { id: 'own/native-model', label: 'Synthetic MiMo', efforts: ['default', 'high'], cost: 'unknown' },
    ])
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('x-api-key')).toBe('synthetic-mimo-key')
  })
  it('MiMo public candidates, OAuth plugins, resolved key overrides and auth headers are not permission', () => {
    expect(mimoModelSources([mimo()], {}, {}, '/synthetic')).toEqual([])
    expect(
      mimoModelSources([mimo()], {}, { own: { type: 'oauth', access: 'foreign' } }, '/synthetic'),
    ).toEqual([])
    const auth = { own: { type: 'api', key: 'own-key' } }
    expect(
      mimoModelSources(
        [mimo()],
        { provider: { own: { options: { apiKey: 'foreign' } } } },
        auth,
        '/synthetic',
      ),
    ).toEqual([])
    expect(
      mimoModelSources([mimo({ headers: { Authorization: 'foreign' } })], {}, auth, '/synthetic'),
    ).toEqual([])
    expect(mimoModelSources([mimo()], { disabled_providers: ['own'] }, auth, '/synthetic')).toEqual([])
  })
  it('MiMo accepts only a literal own-config key that matches the resolved native route', () => {
    const config = { provider: { own: { options: { apiKey: 'own-inline-key' } } } }
    const verified = { own: { key: 'own-inline-key', sourceId: '/synthetic/mimocode.json' } }
    const sources = mimoModelSources([mimo()], config, {}, '/synthetic/auth.json', verified)
    expect(sources[0]?.credential).toEqual({ type: 'api', key: 'own-inline-key' })
    expect(sources[0]?.sourceIds).toContain('/synthetic/mimocode.json')
    expect(
      mimoModelSources([mimo()], config, {}, '/synthetic/auth.json', {
        own: { key: 'other-key', sourceId: '/synthetic/other.json' },
      }),
    ).toEqual([])
  })
  it('MiMo reads only its own auth and uses the same isolated environment for every metadata command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-mimo-source-'))
    roots.push(root)
    await mkdir(join(root, 'data'))
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'data/auth.json'), JSON.stringify({ own: { type: 'api', key: 'own-key' } }))
    const capture = vi.fn(async (argv: string[]) =>
      argv.includes('paths')
        ? `data       ${root}/data\nconfig     ${root}/config\n`
        : argv.includes('config')
          ? '{}'
          : `own/native-model\n${JSON.stringify(mimo(), null, 2)}\n`,
    )
    const result = await readFirstPartyModelSources(
      'mimo',
      '/synthetic/mimo',
      join(root, 'project'),
      capture,
      signal(),
    )
    expect(result).toHaveLength(1)
    expect(capture.mock.calls.map((call) => call[0].slice(1))).toEqual([
      ['debug', 'paths'],
      ['debug', 'config'],
      ['models', '--verbose'],
    ])
    for (const call of capture.mock.calls)
      expect((call as unknown[])[1]).toEqual(firstPartyEnvironment('mimo'))
  })
  it('malformed native configuration errors never reveal credential-shaped output', async () => {
    const secret = 'synthetic-secret-never-display',
      capture = vi.fn(async () => `{apiKey:${secret}}`)
    await expect(
      readFirstPartyModelSources('kimi', '/synthetic/kimi', '/synthetic', capture, signal()),
    ).rejects.toThrow('CLI 配置格式无效')
  })
  it('MiMo rejects a mismatched native identity and truncated catalogue', () => {
    expect(parseMimoModelRecords(`own/native-model\n${JSON.stringify(mimo(), null, 2)}\n`)).toEqual([mimo()])
    expect(() => parseMimoModelRecords(`foreign/native-model\n${JSON.stringify(mimo(), null, 2)}\n`)).toThrow(
      '身份',
    )
    expect(() => parseMimoModelRecords('own/native-model\n{')).toThrow('不完整')
  })
  it('MiMo discovery and execution share the environment that disables foreign SDK sources', () => {
    expect(firstPartyEnvironment('mimo')).toMatchObject({
      MIMOCODE_DISABLE_PROVIDER_ENV: '1',
      MIMOCODE_DISABLE_DEFAULT_PLUGINS: '1',
      MIMOCODE_PURE: '1',
      MIMOCODE_AUTH_CONTENT: '',
    })
    expect(firstPartyEnvironment('kimi')).toEqual({})
  })
  it('cancellation after a scope response never returns stale choices', async () => {
    const controller = new AbortController(),
      fetch = vi.fn<typeof fetch>(async () => {
        controller.abort()
        return new Response(JSON.stringify({ data: [{ id: 'permitted-model' }] }))
      })
    await expect(
      discoverFirstPartySources(parseKimiModelSources(kimi(), '/synthetic'), controller.signal, { fetch }),
    ).rejects.toThrow()
  })
})

async function claudeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cwn-own-models-'))
  roots.push(root)
  const user = join(root, 'claude'),
    project = join(root, 'project')
  await mkdir(user)
  await mkdir(join(project, '.claude'), { recursive: true })
  for (const key of Object.keys(process.env))
    if (/ANTHROPIC|CLAUDE_CODE_(?:OAUTH|USE_|API)|AWS_|GOOGLE_|CLOUD_ML|API_KEY|BEARER_TOKEN/.test(key))
      vi.stubEnv(key, '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', user)
  const capture = vi.fn(async (argv: string[]) =>
    argv.includes('status')
      ? JSON.stringify({ loggedIn: true, authMethod: 'api_key' })
      : '--model <model> full model name\n--output-format <format>',
  )
  return {
    root,
    user,
    project,
    capture,
    read: () => readFirstPartyModelSources('claude', '/synthetic/claude', project, capture, signal()),
  }
}
describe('Claude own native settings API path', () => {
  it('uses own local settings priority and full account model IDs with native default effort', async () => {
    const f = await claudeFixture()
    await writeFile(join(f.user, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'user-key' } }))
    await writeFile(
      join(f.project, '.claude/settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'project-key' } }),
    )
    await writeFile(
      join(f.project, '.claude/settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'local-key' } }),
    )
    const sources = await f.read(),
      fetch = fetchModels(['claude-example-20260101', 'sonnet'])
    expect(sources[0]?.credential).toEqual({ type: 'api', key: 'local-key' })
    expect(await discoverFirstPartySources(sources, signal(), { fetch })).toEqual([
      {
        id: 'claude-example-20260101',
        label: 'claude-example-20260101',
        efforts: ['default'],
        cost: 'unknown',
      },
    ])
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.anthropic.com/v1/models')
    expect(
      workerArguments(
        '/synthetic/claude',
        f.project,
        { cli: 'claude', model: 'claude-example-20260101', effort: 'default' },
        'plan',
        'simulation',
        1000,
      ),
    ).not.toContain('--effort')
  })
  it('does not promote subscription OAuth or empty settings to static aliases', async () => {
    const f = await claudeFixture()
    expect(await f.read()).toEqual([])
    expect(f.capture).not.toHaveBeenCalled()
  })
  it.each([
    { apiKeyHelper: 'foreign-command' },
    { env: { ANTHROPIC_AUTH_TOKEN: 'foreign' } },
    { env: { CLAUDE_CODE_USE_BEDROCK: '1' } },
  ])('rejects ambiguous auth override %j', async (override) => {
    const f = await claudeFixture()
    await writeFile(
      join(f.user, 'settings.json'),
      JSON.stringify({ ...override, env: { ANTHROPIC_API_KEY: 'own-key', ...override.env } }),
    )
    expect(await f.read()).toEqual([])
  })
  it('rejects ambient keys and native auth mode disagreement', async () => {
    const f = await claudeFixture()
    await writeFile(join(f.user, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'own-key' } }))
    vi.stubEnv('ANTHROPIC_API_KEY', 'foreign-key')
    expect(await f.read()).toEqual([])
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    f.capture.mockResolvedValue(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    expect(await f.read()).toEqual([])
  })
})
