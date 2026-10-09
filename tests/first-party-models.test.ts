import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverFirstPartySources,
  assertFirstPartyConfiguration,
  firstPartyEnvironment,
  mimoModelSources,
  parseKimiModelSources,
  parseMimoModelRecords,
  readFirstPartyModelSources,
  readFirstPartyJson,
  claudeManagedSettingsPath,
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

it('uses current Claude managed paths on macOS, Windows, and Linux (synthetic paths)', () => {
  expect(claudeManagedSettingsPath('win32', {})).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json')
  expect(claudeManagedSettingsPath('win32', { ProgramFiles: 'D:\\Program Files' })).toBe(
    'D:\\Program Files\\ClaudeCode\\managed-settings.json',
  )
  expect(claudeManagedSettingsPath('darwin')).toBe(
    '/Library/Application Support/ClaudeCode/managed-settings.json',
  )
  expect(claudeManagedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json')
})

it('rejects a linked own account/config file before reading on platforms without O_NOFOLLOW (synthetic files)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cwn-first-party-link-'))
  roots.push(root)
  const target = join(root, 'other-cli.json'),
    path = join(root, 'auth.json')
  await writeFile(target, JSON.stringify({ xiaomi: { type: 'api', key: 'synthetic-other-cli' } }))
  await symlink(target, path)
  await expect(readFirstPartyJson(path)).rejects.toThrow('账号配置文件不可用')
  expect(await readFile(target, 'utf8')).toContain('synthetic-other-cli')
})

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
  it('MiMo browser-login metadata follows the native Xiaomi route precedence only', () => {
    const model = mimo({ providerID: 'xiaomi' })
    const auth = {
      xiaomi: { type: 'api', key: 'own-login', metadata: { base_url: 'https://own.invalid/v1' } },
    }
    expect(mimoModelSources([model], {}, auth, '/synthetic')[0]?.baseUrl).toBe('https://own.invalid/v1')
    expect(
      mimoModelSources(
        [model],
        { provider: { xiaomi: { options: { baseURL: 'https://configured.invalid/v1' } } } },
        auth,
        '/synthetic',
      )[0]?.baseUrl,
    ).toBe('https://configured.invalid/v1')
    expect(mimoModelSources([mimo()], {}, { own: auth.xiaomi }, '/synthetic')[0]?.baseUrl).toBe(
      mimo().api.url,
    )
    expect(
      mimoModelSources(
        [model],
        {},
        { xiaomi: { ...auth.xiaomi, metadata: { base_url: '{env:FOREIGN}' } } },
        '/synthetic',
      ),
    ).toEqual([])
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
    vi.stubEnv('MIMOCODE_HOME', root)
    vi.stubEnv('HOME', root)
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
  it('parses native MiMo context-window headers without turning the suffix into a model ID', () => {
    for (const suffix of [' — window 1M, compacts at 961K', ' — window 128K, budget 64K, compacts at 59.8K'])
      expect(
        parseMimoModelRecords(`own/native-model${suffix}\n${JSON.stringify(mimo(), null, 2)}\n`),
      ).toEqual([mimo()])
    expect(() =>
      parseMimoModelRecords(
        `foreign/native-model — window 1M, compacts at 961K\n${JSON.stringify(mimo())}\n`,
      ),
    ).toThrow('身份不匹配')
    expect(() =>
      parseMimoModelRecords(`own/native-model unverified suffix\n${JSON.stringify(mimo())}\n`),
    ).toThrow('格式无效')
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

async function mimoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cwn-mimo-preflight-'))
  roots.push(root)
  const project = join(root, 'project', 'child')
  for (const path of ['config', 'data', 'project/child', '.mimocode', 'project/.mimocode'])
    await mkdir(join(root, path), { recursive: true })
  vi.stubEnv('MIMOCODE_HOME', root)
  vi.stubEnv('HOME', root)
  const capture = vi.fn(async (argv: string[]) =>
    argv.includes('paths')
      ? `data ${root}/data\nconfig ${root}/config\n`
      : argv.includes('config')
        ? '{}'
        : `own/native-model\n${JSON.stringify(mimo())}\n`,
  )
  return {
    root,
    project,
    capture,
    check: (abort = signal()) => assertFirstPartyConfiguration('mimo', project, abort),
    read: () => readFirstPartyModelSources('mimo', '/synthetic/mimo', project, capture, signal()),
  }
}

describe('MiMo configuration is checked before any native process can expand references', () => {
  it.each([
    'config/config.json',
    'config/mimocode.json',
    'config/mimocode.jsonc',
    '.mimocode/mimocode.json',
    '.mimocode/mimocode.jsonc',
    'project/mimocode.json',
    'project/mimocode.jsonc',
    'project/.mimocode/mimocode.json',
    'project/.mimocode/mimocode.jsonc',
    'project/child/mimocode.json',
  ])('rejects file interpolation in native source %s without starting metadata', async (source) => {
    const f = await mimoFixture()
    const marker = join(f.root, 'synthetic-foreign-secret')
    await writeFile(marker, 'foreign-placeholder-never-read-by-native')
    await writeFile(
      join(f.root, source),
      JSON.stringify({ provider: { own: { options: { apiKey: `{file:${marker}}` } } } }),
    )
    await expect(f.read()).rejects.toThrow('配置含外部引用')
    expect(f.capture).not.toHaveBeenCalled()
    expect(await readFile(marker, 'utf8')).toBe('foreign-placeholder-never-read-by-native')
  })
  it('rejects env interpolation before native can substitute inherited credentials', async () => {
    const f = await mimoFixture()
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-foreign')
    await writeFile(join(f.root, 'config/mimocode.json'), '{"model":"{env:OPENAI_API_KEY}"}')
    await expect(f.read()).rejects.toThrow('配置含外部引用')
    expect(f.capture).not.toHaveBeenCalled()
  })
  it('ignores inherited config and database selectors in every native command', async () => {
    const f = await mimoFixture()
    for (const key of [
      'MIMOCODE_CONFIG',
      'MIMOCODE_CONFIG_CONTENT',
      'MIMOCODE_CONFIG_DEFAULTS',
      'MIMOCODE_CONFIG_DIR',
      'MIMOCODE_TEST_MANAGED_CONFIG_DIR',
      'MIMOCODE_DB',
    ])
      vi.stubEnv(key, '{file:/synthetic/foreign-credential}')
    await writeFile(join(f.root, 'data/auth.json'), '{"own":{"type":"api","key":"own-key"}}')
    expect(await f.read()).toHaveLength(1)
    for (const call of f.capture.mock.calls) {
      const env = (call as unknown[])[1] as Record<string, string>
      expect(env).toEqual(firstPartyEnvironment('mimo'))
      for (const key of [
        'MIMOCODE_CONFIG',
        'MIMOCODE_CONFIG_CONTENT',
        'MIMOCODE_CONFIG_DEFAULTS',
        'MIMOCODE_CONFIG_DIR',
        'MIMOCODE_TEST_MANAGED_CONFIG_DIR',
        'MIMOCODE_DB',
      ])
        expect(env[key]).toBe('')
    }
  })
  it('keeps literal own settings and local account history usable without writes', async () => {
    const f = await mimoFixture()
    await writeFile(
      join(f.root, 'config/mimocode.json'),
      '{"provider":{"own":{"options":{"apiKey":"own-literal"}}}}',
    )
    const path = join(f.root, 'data/mimocode.db'),
      db = new DatabaseSync(path)
    db.exec('CREATE TABLE account_state (active_org_id TEXT); INSERT INTO account_state VALUES (NULL)')
    db.close()
    const before = await readFile(path),
      files = await readdir(join(f.root, 'data'))
    await expect(f.check()).resolves.toBeUndefined()
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(join(f.root, 'data'))).toEqual(files)
  })
  it('supports own JSONC literal API keys with comments and trailing commas', async () => {
    const f = await mimoFixture()
    const ownKey = 'synthetic//literal-key'
    const path = join(f.root, 'config/mimocode.jsonc')
    await writeFile(
      path,
      `{
      // Native default settings use JSONC.
      "provider": { "own": { "options": { "apiKey": "${ownKey}", }, }, },
    }`,
    )
    f.capture.mockImplementation(async (argv) =>
      argv.includes('paths')
        ? `data ${f.root}/data\nconfig ${f.root}/config\n`
        : argv.includes('config')
          ? JSON.stringify({ provider: { own: { options: { apiKey: ownKey } } } })
          : `own/native-model\n${JSON.stringify(mimo())}\n`,
    )
    const sources = await f.read()
    expect(sources[0]?.credential).toEqual({ type: 'api', key: ownKey })
    expect(sources[0]?.sourceIds).toContain(path)
    expect(
      await discoverFirstPartySources(sources, signal(), { fetch: fetchModels(['upstream-model']) }),
    ).toEqual([
      { id: 'own/native-model', label: 'Synthetic MiMo', efforts: ['default', 'high'], cost: 'unknown' },
    ])
  })
  it('accepts verified XDG roots when MIMOCODE_HOME is unset', async () => {
    const f = await mimoFixture()
    vi.stubEnv('MIMOCODE_HOME', '')
    vi.stubEnv('XDG_CONFIG_HOME', join(f.root, 'xdg-config'))
    vi.stubEnv('XDG_DATA_HOME', join(f.root, 'xdg-data'))
    await mkdir(join(f.root, 'xdg-config/mimocode'), { recursive: true })
    await writeFile(join(f.root, 'xdg-config/mimocode/mimocode.jsonc'), '// own literal config\n{}')
    await expect(f.check()).resolves.toBeUndefined()
    await writeFile(join(f.root, 'xdg-config/mimocode/mimocode.jsonc'), '{"model":"{env:FOREIGN_KEY}"}')
    await expect(f.check()).rejects.toThrow('配置含外部引用')
  })
  it.each(['wellknown', 'organization'])(
    'rejects uninspectable remote %s config before metadata',
    async (mode) => {
      const f = await mimoFixture()
      if (mode === 'wellknown')
        await writeFile(
          join(f.root, 'data/auth.json'),
          '{"https://synthetic.test":{"type":"wellknown","key":"SYNTHETIC","token":"synthetic"}}',
        )
      else {
        const db = new DatabaseSync(join(f.root, 'data/mimocode.db'))
        db.exec(
          "CREATE TABLE account_state (active_org_id TEXT); INSERT INTO account_state VALUES ('synthetic-org')",
        )
        db.close()
      }
      await expect(f.read()).rejects.toThrow('远程配置无法核验')
      expect(f.capture).not.toHaveBeenCalled()
    },
  )
  it('sees an active organization committed in the live WAL without changing history', async () => {
    const f = await mimoFixture(),
      path = join(f.root, 'data/mimocode.db')
    const db = new DatabaseSync(path)
    try {
      db.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE account_state (active_org_id TEXT); INSERT INTO account_state VALUES ('synthetic-wal-org')",
      )
      const before = await readFile(path),
        wal = await readFile(`${path}-wal`)
      await expect(f.read()).rejects.toThrow('远程配置无法核验')
      expect(f.capture).not.toHaveBeenCalled()
      expect(await readFile(path)).toEqual(before)
      expect(await readFile(`${path}-wal`)).toEqual(wal)
    } finally {
      db.close()
    }
  })
  it('rechecks configuration before the next native metadata query', async () => {
    const f = await mimoFixture()
    f.capture.mockImplementationOnce(async () => {
      await writeFile(join(f.root, 'config/mimocode.json'), '{"model":"{file:/synthetic/foreign}"}')
      return `data ${f.root}/data\nconfig ${f.root}/config\n`
    })
    await expect(f.read()).rejects.toThrow('配置含外部引用')
    expect(f.capture).toHaveBeenCalledOnce()
  })
  it('rejects native legacy imports and linked configuration files', async () => {
    const f = await mimoFixture()
    await writeFile(join(f.root, 'config/config'), 'provider = "synthetic"')
    await expect(f.read()).rejects.toThrow('配置来源无法确认')
    await rm(join(f.root, 'config/config'))
    await writeFile(join(f.root, 'other-config'), '{}')
    await symlink(join(f.root, 'other-config'), join(f.root, 'config/mimocode.json'))
    await expect(f.read()).rejects.toThrow('配置来源无法确认')
    expect(f.capture).not.toHaveBeenCalled()
  })
  it('checks the physical project ancestors when the selected project is a symlink', async () => {
    const f = await mimoFixture()
    const physical = join(f.root, 'physical')
    await mkdir(join(physical, 'child'), { recursive: true })
    await writeFile(join(physical, 'mimocode.json'), '{"model":"{env:SYNTHETIC_FOREIGN}"}')
    await symlink(join(physical, 'child'), join(f.root, 'selected-project'))
    await expect(
      readFirstPartyModelSources(
        'mimo',
        '/synthetic/mimo',
        join(f.root, 'selected-project'),
        f.capture,
        signal(),
      ),
    ).rejects.toThrow('配置含外部引用')
    expect(f.capture).not.toHaveBeenCalled()
  })
  it('rejects a native root mismatch before querying resolved configuration', async () => {
    const f = await mimoFixture()
    f.capture.mockResolvedValue('data /synthetic/foreign\nconfig /synthetic/foreign\n')
    await expect(f.read()).rejects.toThrow('配置来源无法确认')
    expect(f.capture).toHaveBeenCalledOnce()
  })
  it('honors cancellation before reading configuration or starting native metadata', async () => {
    const f = await mimoFixture(),
      control = new AbortController()
    control.abort()
    await expect(f.check(control.signal)).rejects.toThrow()
    expect(f.capture).not.toHaveBeenCalled()
    await expect(assertFirstPartyConfiguration('claude', '/synthetic', signal())).resolves.toBeUndefined()
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
