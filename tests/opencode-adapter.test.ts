import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverOpenCode,
  OpenCodeProtocol,
  parseOpenCodeModels,
  prepareOpenCode,
} from '../src/host/opencode-adapter.ts'
import { readOpenCodeProfile, snapshotOpenCodeAuth } from '../src/host/opencode-native.ts'
import { validatePreference } from '../src/host/adapters.ts'
import type { EventInput } from '../src/host/protocol.ts'

const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'opencode-adapter-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
const fixtureModel = (variants = {}) =>
  'fixture/model\n' +
  JSON.stringify({ providerID: 'fixture', id: 'model', name: 'Synthetic model', variants }, null, 2) +
  '\n'
function native(
  root: string,
  providers: Record<string, any> = {
    fixture: { options: { baseURL: 'https://example.test/v1' }, models: { model: {} } },
  },
) {
  const nativeHome = join(root, 'native'),
    authDirectory = join(root, 'auth')
  mkdirSync(join(authDirectory, 'opencode'), { recursive: true, mode: 0o700 })
  mkdirSync(join(nativeHome, '.config/opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(authDirectory, 'opencode/auth.json'),
    JSON.stringify({ fixture: { type: 'api', key: 'SYNTHETIC-NATIVE-KEY' } }),
    { mode: 0o600 },
  )
  writeFileSync(join(nativeHome, '.config/opencode/opencode.json'), JSON.stringify({ provider: providers }), {
    mode: 0o600,
  })
  return { nativeHome, authDirectory }
}
const metadata404 = async () => new Response(JSON.stringify({ data: [{ id: 'model' }] }))
const dump = (entries: any[]) =>
  entries.map((entry) => `${entry.providerID}/${entry.id}\n${JSON.stringify(entry)}\n`).join('')
const row = (id: string, providerID = 'fixture', extra: Record<string, unknown> = {}) => ({
  id,
  providerID,
  name: id,
  variants: {},
  api: { id, url: 'https://example.test/v1', npm: '@ai-sdk/openai-compatible' },
  cost: { input: 0, output: 0 },
  ...extra,
})
function fixture() {
  const events: EventInput[] = [],
    ids: string[] = []
  const parser = new OpenCodeProtocol(
    (event) => events.push(event),
    (id) => ids.push(id),
    8192,
  )
  const send = (...events: unknown[]) =>
    parser.feed(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const step = { type: 'step_start', sessionID: 'ses_fixture' }
  const finish = (reason = 'stop') => ({ type: 'step_finish', sessionID: 'ses_fixture', part: { reason } })
  return { parser, events, ids, send, step, finish }
}
describe('OpenCode native adapter (explicitly synthetic fixtures)', () => {
  it('isolates state, selects native plan, and preserves shell-like text as one argument', async () => {
    const root = directory(),
      prompt = '$(touch nope); `echo unsafe`\n第二行'
    const prepared = await prepareOpenCode({
      executable: '/bin/opencode',
      project: '/project',
      preference: { model: 'fixture/model', effort: 'default' },
      mode: 'plan',
      prompt,
      conversationId: 'ses_existing',
      stateDirectory: root,
      ...native(root),
    })
    expect(prepared.argv.slice(-2)).toEqual(['--', prompt])
    expect(prepared.argv).toContain('plan')
    expect(prepared.argv).toContain('ses_existing')
    expect(prepared.argv).not.toContain('--auto')
    expect(prepared.argv).not.toContain('--continue')
    expect(prepared.argv).not.toContain('--variant')
    const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!)
    expect(config).toMatchObject({
      model: 'fixture/model',
      small_model: 'fixture/model',
      enabled_providers: ['fixture'],
      permission: { '*': 'ask', edit: 'deny', bash: 'deny' },
    })
    expect(prepared.env).not.toHaveProperty('ZHIPU_API_KEY')
    expect(statSync(root).mode & 0o077).toBe(0)
    expect(statSync(prepared.env.OPENCODE_CONFIG!).mode & 0o077).toBe(0)
    expect(
      JSON.parse(readFileSync(prepared.env.OPENCODE_CONFIG!, 'utf8')).provider.fixture.models,
    ).toHaveProperty('model')
  })
  it('accepts edits but preserves additional approval and the explicit native effort', async () => {
    const root = directory()
    const prepared = await prepareOpenCode({
      executable: '/bin/opencode',
      project: '/project',
      preference: { model: 'fixture/model', effort: 'low' },
      mode: 'accept-edits',
      prompt: 'test',
      stateDirectory: root,
      ...native(root),
    })
    expect(prepared.argv).toContain('build')
    expect(
      prepared.argv.slice(prepared.argv.indexOf('--variant'), prepared.argv.indexOf('--variant') + 2),
    ).toEqual(['--variant', 'low'])
    expect(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission).toMatchObject({
      edit: 'allow',
      bash: 'ask',
      '*': 'ask',
    })
  })
  it('rejects linked state directories before writing or changing anything outside its state', async () => {
    const state = directory(),
      outside = directory(),
      path = join(outside, 'cliworker.json')
    writeFileSync(path, 'SENTINEL', { mode: 0o640 })
    const beforeDirectoryMode = statSync(outside).mode,
      beforeFileMode = statSync(path).mode
    symlinkSync(outside, join(state, 'config'))
    await expect(
      prepareOpenCode({
        executable: '/bin/opencode',
        project: '/project',
        stateDirectory: state,
        ...native(state),
        ...native(state),
        preference: { model: 'fixture/model', effort: 'default' },
        mode: 'plan',
        prompt: 'synthetic read only task',
      }),
    ).rejects.toThrow('symlink')
    expect(readFileSync(path, 'utf8')).toBe('SENTINEL')
    expect(statSync(path).mode).toBe(beforeFileMode)
    expect(statSync(outside).mode).toBe(beforeDirectoryMode)
    const linkedRoot = join(directory(), 'linked-state')
    symlinkSync(outside, linkedRoot)
    await expect(
      discoverOpenCode(
        '/bin/opencode',
        async () => {
          throw new Error('Must not start a CLI')
        },
        linkedRoot,
        native(state).authDirectory,
        false,
        { nativeHome: native(state).nativeHome, probeOptions: { fetch: metadata404 } },
      ),
    ).rejects.toThrow('symlink')
  })
  it('replaces a planted configuration file symlink without overwriting its target', async () => {
    const state = directory(),
      outside = join(directory(), 'sentinel.json')
    writeFileSync(outside, 'SENTINEL', { mode: 0o640 })
    mkdirSync(join(state, 'config'))
    const config = join(state, 'config', 'cliworker.json')
    symlinkSync(outside, config)
    const before = statSync(outside).mode
    const prepared = await prepareOpenCode({
      executable: '/bin/opencode',
      project: '/project',
      stateDirectory: state,
      ...native(state),
      preference: { model: 'fixture/model', effort: 'default' },
      mode: 'plan',
      prompt: 'synthetic read only task',
    })
    expect(readFileSync(outside, 'utf8')).toBe('SENTINEL')
    expect(statSync(outside).mode).toBe(before)
    expect(lstatSync(config).isSymbolicLink()).toBe(false)
    expect(
      JSON.parse(readFileSync(prepared.env.OPENCODE_CONFIG!, 'utf8')).provider.fixture.models,
    ).toHaveProperty('model')
    expect(statSync(config).mode & 0o777).toBe(0o600)
  })
  it('queries native catalogue without a prompt and never guesses variants', async () => {
    const calls: unknown[] = [],
      root = directory(),
      account = native(root)
    const models = await discoverOpenCode(
      '/bin/opencode',
      async (argv, env) => {
        calls.push({ argv, env })
        return fixtureModel({ low: {}, max: {}, fictional: {} })
      },
      root,
      account.authDirectory,
      false,
      { nativeHome: account.nativeHome, probeOptions: { fetch: metadata404 } },
    )
    expect((calls[0] as any).argv).toEqual(['/bin/opencode', 'models', '--verbose'])
    expect(models).toEqual([
      { id: 'fixture/model', label: 'Synthetic model', efforts: ['default', 'low', 'max'], cost: 'unknown' },
    ])
    expect(parseOpenCodeModels(fixtureModel())[0]?.efforts).toEqual(['default'])
    expect(() => parseOpenCodeModels(fixtureModel().replace('fixture/model', 'other/model'))).toThrow(
      /identity/,
    )
    expect(() => parseOpenCodeModels('fixture/model\n{')).toThrow(/Incomplete/)
  })
  it('hides anonymous public catalogues and expired accounts without running metadata subprocesses', async () => {
    const root = directory(),
      account = native(root),
      capture = vi.fn(async () => dump([row('mimo-v2.5-free', 'opencode')]))
    writeFileSync(join(account.authDirectory, 'opencode/auth.json'), '{}')
    expect(
      await discoverOpenCode('/bin/opencode', capture, root, account.authDirectory, false, {
        nativeHome: account.nativeHome,
        probeOptions: { fetch: metadata404 },
      }),
    ).toEqual([])
    writeFileSync(
      join(account.authDirectory, 'opencode/auth.json'),
      JSON.stringify({
        openai: { type: 'oauth', access: 'SYNTHETIC-EXPIRED', refresh: 'SYNTHETIC-REFRESH', expires: 1 },
      }),
    )
    expect(
      await discoverOpenCode('/bin/opencode', capture, root, account.authDirectory, false, {
        nativeHome: account.nativeHome,
        probeOptions: { fetch: metadata404 },
      }),
    ).toEqual([])
    expect(capture).not.toHaveBeenCalled()
  })
  it('intersects API account metadata with native routes, prices proven free first and ignores SDK default zero', async () => {
    const root = directory(),
      account = native(root, {
        fixture: {
          options: { baseURL: 'https://example.test/v1' },
          models: { free: {}, paid: {}, unknown: {} },
        },
      })
    const models = await discoverOpenCode(
      '/bin/opencode',
      async () => dump([row('unknown'), row('paid'), row('free'), row('catalog-only'), row('free')]),
      root,
      account.authDirectory,
      false,
      {
        nativeHome: account.nativeHome,
        probeOptions: {
          fetch: async () =>
            new Response(
              JSON.stringify({
                data: [
                  { id: 'free', pricing: { input: 0, output: 0 } },
                  { id: 'paid', free: true, pricing: { input: 0, output: 0, request: 1 } },
                  { id: 'unknown' },
                ],
              }),
            ),
        },
      },
    )
    expect(models.map(({ id, cost }) => ({ id, cost }))).toEqual([
      { id: 'fixture/free', cost: 'free' },
      { id: 'fixture/paid', cost: 'paid' },
      { id: 'fixture/unknown', cost: 'unknown' },
    ])
  })
  it('does not rescue denied or unreachable accounts using custom definitions', async () => {
    const root = directory(),
      account = native(root),
      capture = async () => fixtureModel()
    for (const status of [401, 403, 404, 405, 500])
      expect(
        await discoverOpenCode('/bin/opencode', capture, root, account.authDirectory, false, {
          nativeHome: account.nativeHome,
          probeOptions: { fetch: async () => new Response('{}', { status }) },
        }),
      ).toEqual([])
    expect(
      await discoverOpenCode('/bin/opencode', capture, root, account.authDirectory, false, {
        nativeHome: account.nativeHome,
        probeOptions: {
          fetch: async () => {
            throw new Error('SYNTHETIC-SECRET')
          },
        },
      }),
    ).toEqual([])
  })
  it('uses model API endpoint scopes independently and hides unknown custom authorization headers', async () => {
    const root = directory(),
      account = native(root, { fixture: { models: { one: {}, two: {}, injected: {} } } }),
      paths: string[] = []
    const models = await discoverOpenCode(
      '/bin/opencode',
      async () =>
        dump([
          row('one', 'fixture', {
            api: { id: 'one', url: 'https://one.example.test/v1', npm: '@ai-sdk/openai-compatible' },
          }),
          row('two', 'fixture', {
            api: { id: 'two', url: 'https://two.example.test/v1', npm: '@ai-sdk/openai-compatible' },
          }),
          row('injected', 'fixture', { headers: { Authorization: 'SYNTHETIC-OTHER-KEY' } }),
        ]),
      root,
      account.authDirectory,
      false,
      {
        nativeHome: account.nativeHome,
        probeOptions: {
          fetch: async (url) => {
            paths.push(String(url))
            return new Response(
              JSON.stringify({ data: [{ id: String(url).includes('one.') ? 'one' : 'unrelated' }] }),
            )
          },
        },
      },
    )
    expect(models.map((model) => model.id)).toEqual(['fixture/one'])
    expect(paths.sort()).toEqual(['https://one.example.test/v1/models', 'https://two.example.test/v1/models'])
  })
  it('uses current OAuth account scope and quota rather than native static provider filters', async () => {
    const root = directory(),
      account = native(root, {})
    writeFileSync(
      join(account.authDirectory, 'opencode/auth.json'),
      JSON.stringify({
        openai: {
          type: 'oauth',
          access: 'SYNTHETIC-OAUTH',
          expires: Date.now() + 120000,
          accountId: 'synthetic-account',
        },
      }),
    )
    const capture = async () =>
      dump(
        ['gpt-5.4', 'gpt-5.5-pro', 'gpt-5.4-mini'].map((id) =>
          row(id, 'openai', { api: { id, url: 'https://api.openai.com/v1', npm: '@ai-sdk/openai' } }),
        ),
      )
    const fetcher = async (url: any) =>
      new Response(
        JSON.stringify(
          String(url).includes('/wham/usage')
            ? { plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false } }
            : {
                models: [
                  { slug: 'gpt-5.4', supported_in_api: true },
                  { slug: 'gpt-5.4-mini', supported_in_api: false },
                ],
              },
        ),
      )
    expect(
      (
        await discoverOpenCode('/bin/opencode', capture, root, account.authDirectory, false, {
          nativeHome: account.nativeHome,
          probeOptions: { fetch: fetcher },
        })
      ).map(({ id, cost }) => ({ id, cost })),
    ).toEqual([{ id: 'openai/gpt-5.4', cost: 'paid' }])
    expect(
      await discoverOpenCode('/bin/opencode', capture, root, account.authDirectory, false, {
        nativeHome: account.nativeHome,
        probeOptions: {
          fetch: async () => {
            throw new Error('unavailable')
          },
        },
      }),
    ).toEqual([])
  })
  it('keeps managed CN credentials only in metadata memory and child env while honoring the current account model scope', async () => {
    const root = directory(),
      account = native(root, {}),
      marker = 'SYNTHETIC-MANAGED-DO-NOT-WRITE'
    writeFileSync(join(account.authDirectory, 'opencode/auth.json'), '{}')
    let captured: Record<string, string> | undefined,
      requested = ''
    const models = await discoverOpenCode(
      '/bin/opencode',
      async (_args, env) => {
        captured = env
        return dump([row('glm-5.3-flash', 'zhipuai-coding-plan'), row('glm-5.3', 'zhipuai-coding-plan')])
      },
      root,
      account.authDirectory,
      true,
      {
        nativeHome: account.nativeHome,
        credentialEnv: { ZHIPU_API_KEY: marker },
        probeOptions: {
          fetch: async (url) => {
            requested = String(url)
            return new Response(
              JSON.stringify({ data: [{ id: 'glm-5.3-flash', free: true }, { id: 'glm-5.3' }] }),
            )
          },
        },
      },
    )
    expect(models.map(({ id, cost }) => ({ id, cost }))).toEqual([
      { id: 'zhipuai-coding-plan/glm-5.3', cost: 'unknown' },
      { id: 'zhipuai-coding-plan/glm-5.3-flash', cost: 'unknown' },
    ])
    const preference = {
      cli: 'opencode' as const,
      model: 'zhipuai-coding-plan/glm-5.3',
      effort: 'default' as const,
    }
    const catalogue = { cli: 'opencode' as const, models, notice: 'Synthetic current account metadata' }
    expect(() => validatePreference(preference, catalogue)).not.toThrow()
    expect(() =>
      validatePreference({ ...preference, model: 'zhipuai-coding-plan/unknown-model' }, catalogue),
    ).toThrow()
    const prepared = await prepareOpenCode({
      executable: '/bin/opencode',
      project: '/project',
      preference,
      mode: 'plan',
      prompt: 'synthetic task',
      stateDirectory: join(root, 'selected'),
      authDirectory: account.authDirectory,
      managedCredentials: true,
    })
    expect(
      prepared.argv.slice(prepared.argv.indexOf('--model'), prepared.argv.indexOf('--model') + 2),
    ).toEqual(['--model', preference.model])
    expect(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      model: preference.model,
      small_model: preference.model,
      enabled_providers: ['zhipuai-coding-plan'],
    })
    await expect(
      prepareOpenCode({
        executable: '/bin/opencode',
        project: '/project',
        preference: { ...preference, model: 'openai/gpt-5.4' },
        mode: 'plan',
        prompt: 'synthetic task',
        stateDirectory: join(root, 'unrelated'),
        managedCredentials: true,
      }),
    ).rejects.toThrow('CN Coding Plan')
    expect(captured!.ZHIPU_API_KEY).toBe(marker)
    expect(requested).toBe('https://open.bigmodel.cn/api/coding/paas/v4/models')
    expect(readFileSync(join(captured!.XDG_DATA_HOME!, 'opencode/auth.json'), 'utf8')).not.toContain(marker)
    expect(readFileSync(captured!.OPENCODE_CONFIG!, 'utf8')).not.toContain(marker)
  })
  it('conservatively hides Zen public zero-cost routes without treating unrelated custom endpoints as that restriction', async () => {
    const root = directory(),
      account = native(root, {})
    writeFileSync(
      join(account.authDirectory, 'opencode/auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'SYNTHETIC-ZEN' } }),
    )
    const models = await discoverOpenCode(
      '/bin/opencode',
      async () =>
        dump([
          row('mimo-v2.5-free', 'opencode', {
            api: { id: 'mimo-v2.5-free', url: 'https://opencode.ai/zen/v1' },
          }),
          row('ling-3.0-flash-fin-free', 'opencode', {
            api: { id: 'ling-3.0-flash-fin-free', url: 'https://opencode.ai/zen/v1' },
          }),
          row('explicit-custom', 'opencode', {
            api: { id: 'explicit-custom', url: 'https://custom.example.test/v1' },
          }),
        ]),
      root,
      account.authDirectory,
      false,
      {
        nativeHome: account.nativeHome,
        probeOptions: {
          fetch: async () =>
            new Response(
              JSON.stringify({
                data: [
                  { id: 'mimo-v2.5-free', is_free: true },
                  { id: 'ling-3.0-flash-fin-free', is_free: true },
                  { id: 'explicit-custom', is_free: true },
                ],
              }),
            ),
        },
      },
    )
    expect(models.map((model) => model.id)).toEqual(['opencode/explicit-custom'])
  })
  it('redacts native credential-echo labels and never returns credential-echo IDs', async () => {
    const root = directory(),
      account = native(root),
      marker = 'SYNTHETIC-NATIVE-KEY'
    const models = await discoverOpenCode(
      '/bin/opencode',
      async () => dump([row('model', 'fixture', { name: marker }), row(marker)]),
      root,
      account.authDirectory,
      false,
      {
        nativeHome: account.nativeHome,
        probeOptions: {
          fetch: async () => new Response(JSON.stringify({ data: [{ id: 'model' }, { id: marker }] })),
        },
      },
    )
    expect(models).toEqual([{ id: 'fixture/model', label: 'model', efforts: ['default'], cost: 'unknown' }])
    expect(JSON.stringify(models)).not.toContain(marker)
  })
  it('cancels an in-flight metadata fetch and does not return late choices or write source auth', async () => {
    const root = directory(),
      account = native(root),
      controller = new AbortController(),
      before = readFileSync(join(account.authDirectory, 'opencode/auth.json'), 'utf8')
    let began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const pending = discoverOpenCode(
      '/bin/opencode',
      async () => fixtureModel(),
      root,
      account.authDirectory,
      false,
      {
        nativeHome: account.nativeHome,
        signal: controller.signal,
        probeOptions: {
          fetch: async (_url, init) => {
            began()
            return new Promise((_resolve, reject) => {
              init!.signal!.addEventListener('abort', () => reject(new Error('metadata cancelled')), {
                once: true,
              })
            })
          },
        },
      },
    )
    await started
    controller.abort(new Error('synthetic cancelled'))
    await expect(pending).rejects.toThrow('synthetic cancelled')
    expect(readFileSync(join(account.authDirectory, 'opencode/auth.json'), 'utf8')).toBe(before)
  })
  it('merges native+plugin auth safely, resolves explicit env/file API config and preserves refreshed snapshots', async () => {
    const root = directory(),
      account = native(root, {}),
      data = join(account.nativeHome, '.local/share/opencode'),
      secret = join(root, 'secret')
    mkdirSync(data, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(data, 'auth.json'),
      JSON.stringify({ fixture: { type: 'oauth', access: 'SYNTHETIC-OLD', expires: 1 } }),
      { mode: 0o600 },
    )
    writeFileSync(join(account.authDirectory, 'opencode/auth.json'), '{}')
    writeFileSync(secret, 'SYNTHETIC-FILE-KEY', { mode: 0o600 })
    writeFileSync(
      join(account.nativeHome, '.config/opencode/opencode.json'),
      `{"provider":{"fixture":{"options":{"apiKey":"{file:${secret}}","baseURL":"https://example.test"},"models":{"model":{}}}}, // trailing comment\n}`,
    )
    const profile = await readOpenCodeProfile(account.authDirectory, { nativeHome: account.nativeHome })
    expect(profile.auth.fixture).toMatchObject({ type: 'api', key: 'SYNTHETIC-FILE-KEY' })
    const snapshot = await snapshotOpenCodeAuth(account.authDirectory, profile.auth, ['fixture'])
    writeFileSync(
      join(snapshot, 'opencode/auth.json'),
      JSON.stringify({ fixture: { type: 'api', key: 'SYNTHETIC-REFRESHED' } }),
      { mode: 0o600 },
    )
    expect(await snapshotOpenCodeAuth(account.authDirectory, profile.auth, ['fixture'])).toBe(snapshot)
    expect(readFileSync(join(snapshot, 'opencode/auth.json'), 'utf8')).toContain('SYNTHETIC-REFRESHED')
    vi.stubEnv('CLIWORKER_SYNTHETIC_API', 'SYNTHETIC-ENV-KEY')
    writeFileSync(
      join(account.nativeHome, '.config/opencode/opencode.json'),
      '{"provider":{"fixture":{"options":{"apiKey":"{env:CLIWORKER_SYNTHETIC_API}"}}}}',
    )
    expect(
      (await readOpenCodeProfile(account.authDirectory, { nativeHome: account.nativeHome })).auth.fixture.key,
    ).toBe('SYNTHETIC-ENV-KEY')
    expect(readFileSync(join(data, 'auth.json'), 'utf8')).toContain('SYNTHETIC-OLD')
  })
  it('reads a bounded large public cache without expanding the private credential file limit', async () => {
    const root = directory(),
      account = native(root),
      cache = join(account.nativeHome, '.cache/opencode')
    mkdirSync(cache, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(cache, 'models.json'),
      JSON.stringify({
        fixture: { models: { model: { cost: { input: 1, output: 2 } } } },
        publicPadding: 'x'.repeat(4300000),
      }),
    )
    expect(
      (await readOpenCodeProfile(account.authDirectory, { nativeHome: account.nativeHome })).catalog.fixture
        .models.model.cost,
    ).toEqual({ input: 1, output: 2 })
    writeFileSync(
      join(account.authDirectory, 'opencode/auth.json'),
      JSON.stringify({ fixture: { type: 'api', key: 'x'.repeat(4300000) } }),
    )
    await expect(
      readOpenCodeProfile(account.authDirectory, { nativeHome: account.nativeHome }),
    ).rejects.toThrow('无法安全读取')
  })
  it('waits for EOF and a terminal stop, with split UTF-8 and an actual identity', () => {
    const f = fixture()
    f.send(f.step)
    const bytes = Buffer.from(
      JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { id: 'part1', text: '真实中文' } }) +
        '\n',
    )
    for (const byte of bytes) f.parser.feed(Buffer.from([byte]))
    f.send(f.finish())
    expect(f.parser.result).toBeUndefined()
    f.parser.end()
    expect(f.parser.result).toEqual({
      conversationId: 'ses_fixture',
      status: 'SUCCESS',
      response: '真实中文',
    })
    expect(f.ids).toEqual(['ses_fixture'])
    expect(f.events.filter((event) => event.kind === 'assistant')).toHaveLength(1)
  })
  it('does not accept intermediate tool-calls or an unfinished tool at EOF', () => {
    const f = fixture()
    f.send(f.step, f.finish('tool-calls'))
    f.parser.end()
    expect(f.parser.result).toBeUndefined()
    const g = fixture()
    g.send(
      g.step,
      {
        type: 'tool_use',
        sessionID: 'ses_fixture',
        part: { callID: 'call1', tool: 'write', state: { status: 'running' } },
      },
      g.finish(),
    )
    g.parser.end()
    expect(g.parser.result).toBeUndefined()
  })
  it('latches permission/tool failure despite later explanatory text and a clean stop', () => {
    const f = fixture()
    f.send(
      f.step,
      {
        type: 'tool_use',
        sessionID: 'ses_fixture',
        part: { callID: 'call1', tool: 'write', state: { status: 'error', error: 'permission rejected' } },
      },
      f.finish('tool-calls'),
      f.step,
      { type: 'text', sessionID: 'ses_fixture', part: { id: 'part2', text: 'Permission was denied.' } },
      f.finish(),
    )
    f.parser.end()
    expect(f.parser.result).toMatchObject({ status: 'ERROR', error: 'permission rejected' })
    expect(f.events.find((event) => event.kind === 'tool')?.state).toBe('FAILED')
  })
  it('does not upgrade an API error or length termination into success', () => {
    const f = fixture()
    f.send({
      type: 'error',
      sessionID: 'ses_fixture',
      error: { data: { statusCode: 403, message: 'free tier rejected' } },
    })
    f.parser.end()
    expect(f.parser.result).toMatchObject({ status: 'ERROR', error: 'free tier rejected' })
    const g = fixture()
    g.send(g.step, g.finish('length'))
    g.parser.end()
    expect(g.parser.result?.status).toBe('ERROR')
  })
  it('rejects identity changes, forged completion without a start and trailing events', () => {
    const f = fixture()
    f.send(f.step)
    expect(() => f.send({ type: 'step_start', sessionID: 'ses_other' })).toThrow(/changed/)
    const g = fixture()
    expect(() => g.send(g.finish())).toThrow(/finish/)
    const h = fixture()
    h.send(h.step, h.finish())
    expect(() => h.send(h.step)).toThrow(/after final stop/)
  })
  it('rejects malformed and oversized framing and does not emit hidden reasoning', () => {
    const f = fixture()
    expect(() => f.parser.feed('not json\n')).toThrow(/JSONL/)
    const g = fixture()
    expect(() => g.parser.feed('x'.repeat(8193))).toThrow(/maxLineBytes/)
    const h = fixture()
    h.send(
      h.step,
      { type: 'reasoning', sessionID: 'ses_fixture', part: { text: 'synthetic private reasoning' } },
      h.finish(),
    )
    h.parser.end()
    expect(h.events.some((event) => JSON.stringify(event).includes('private reasoning'))).toBe(false)
  })
})
