import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  existsSync,
  linkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { discoverZCode, parseZCodeBuiltin, prepareZCode, ZCodeProtocol } from '../src/host/zcode-adapter.ts'
import type { EventInput } from '../src/host/protocol.ts'

const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'zcode-adapter-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
const route = 'account:bigmodel-individual-coding-plan'
// Explicitly synthetic configuration and stream fixtures, using documented native fields.
const builtin = () => ({
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: route,
          config: {
            builtinModelIds: ['GLM-5.3-Flash', 'UNACCEPTED'],
            api: { type: 'anthropic-messages', baseUrl: 'https://example.test/api/' },
          },
        },
      ],
    },
    modelConfigRules: {
      modelRules: [
        {
          modelMatch: '.*',
          config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } },
        },
        {
          modelMatch: 'glm-5\\.3(?:-flash)?',
          config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } },
        },
        { modelMatch: 'glm', config: { optionSpecs: { reasoningLevel: { values: ['ultra'] } } } },
      ],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
})
function setup() {
  const root = directory(),
    path = join(root, 'builtin.json'),
    state = join(root, 'state')
  writeFileSync(path, JSON.stringify(builtin()))
  return {
    root,
    path,
    state,
    input: {
      executable: '/native/zcode.cjs',
      project: '/project',
      preference: { model: `${route}/GLM-5.3-Flash`, effort: 'low' as const },
      mode: 'plan' as const,
      prompt: '/model list\n$(touch nope); `echo shell`',
      stateDirectory: state,
      builtinConfig: path,
      nativeHome: join(root, 'native-home'),
      authDirectory: join(root, 'auth'),
    },
  }
}
const personal = (): any => ({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
})
function savePersonal(base: string, value: unknown): string {
  const path = join(base, '.zcode/v2/provider_config.json')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
  return path
}
function fixture(maxLineBytes = 8192) {
  const events: EventInput[] = [],
    ids: string[] = []
  const parser = new ZCodeProtocol(
    (event) => events.push(event),
    (id) => ids.push(id),
    maxLineBytes,
  )
  const event = (type: string, payload: unknown = {}) => ({ type, sessionId: 'sess_fixture', payload })
  const send = (...events: unknown[]) => parser.feed(events.map((v) => JSON.stringify(v)).join('\n') + '\n')
  const complete = () => event('turn.completed', { resultType: 'success', response: '完成' })
  const result = () => ({ type: 'result', sessionId: 'sess_fixture', response: '完成' })
  return { parser, events, ids, event, send, complete, result }
}

describe('ZCode adapter (explicitly synthetic fixtures)', () => {
  it('keeps native identity, mode, auth location and prompt as separate arguments', async () => {
    const { input, root, state } = setup(),
      auth = join(root, 'auth')
    mkdirSync(auth, { mode: 0o700 })
    const launch = await prepareZCode({ ...input, conversationId: 'sess_original', authDirectory: auth })
    expect(launch.argv[1]).toContain('zcode-resume.mjs')
    const request = JSON.parse(readFileSync(launch.argv[2], 'utf8'))
    expect(statSync(launch.argv[2]).mode & 0o777).toBe(0o600)
    expect(request.selection).toEqual({
      providerId: route,
      modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'low' },
    })
    expect(request.argv).toEqual([
      process.execPath,
      input.executable,
      '--cwd',
      input.project,
      '--mode',
      'plan',
      '--output-format',
      'stream-json',
      '--disallowedTools',
      expect.any(String),
      '--resume',
      'sess_original',
      '--prompt',
      `任务：\n${input.prompt}`,
    ])
    const denied = request.argv[request.argv.indexOf('--disallowedTools') + 1].split(',')
    expect(denied).toEqual(
      expect.arrayContaining([
        'Agent',
        'Task',
        'Skill',
        'CreateWorkflow',
        'AmendWorkflow',
        'ResumeWorkflowRun',
        'EvalWorkflowSnippet',
        'SendMessage',
        'ReadSessionContext',
        'mcp__node_repl__js',
      ]),
    )
    for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'mcp__*']) expect(denied).not.toContain(tool)
    expect(new Set(denied).size).toBe(denied.length)
    expect(launch.env.ZCODE_DATA_BASE_DIR).toBe(auth)
    expect(
      JSON.parse(readFileSync(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config
        .defaultModelSelection,
    ).toEqual({ providerId: route, modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } })
    for (const path of [state, join(state, 'logs'), join(state, 'storage'), join(state, 'tmp')])
      expect(statSync(path).mode & 0o777).toBe(0o700)
    expect(statSync(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).mode & 0o777).toBe(0o600)
    const edit = await prepareZCode({
      ...input,
      mode: 'accept-edits',
      preference: { ...input.preference, effort: 'default' },
    })
    expect(edit.argv).toContain('edit')
    expect(edit.argv).not.toContain('--resume')
    expect(
      JSON.parse(readFileSync(edit.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config
        .defaultModelSelection.options,
    ).toEqual({ reasoningLevel: 'max' })
    expect(readFileSync(input.builtinConfig, 'utf8')).toBe(JSON.stringify(builtin()))
  })
  it('replaces a planted personal-config symlink without touching its target', async () => {
    const { root, input, state } = setup(),
      outside = join(root, 'unrelated.json')
    mkdirSync(state)
    writeFileSync(outside, 'untouched', { mode: 0o644 })
    symlinkSync(outside, join(state, 'personal.json'))
    await prepareZCode(input)
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    expect(statSync(outside).mode & 0o777).toBe(0o644)
    expect(lstatSync(join(state, 'personal.json')).isSymbolicLink()).toBe(false)
    expect(statSync(join(state, 'personal.json')).mode & 0o777).toBe(0o600)
  })
  it.each(['state', 'storage', 'logs', 'tmp'])(
    'rejects a planted %s directory link before writing there',
    async (target) => {
      const { root, input, state } = setup(),
        outside = join(root, 'unrelated')
      mkdirSync(outside, { mode: 0o755 })
      if (target !== 'state') mkdirSync(state)
      symlinkSync(outside, target === 'state' ? state : join(state, target))
      await expect(prepareZCode(input)).rejects.toThrow('must not be a symlink')
      expect(statSync(outside).mode & 0o777).toBe(0o755)
      expect(existsSync(join(outside, 'personal.json'))).toBe(false)
    },
  )
  it('reads every visible installed model with native regex matching; never spawns or reads auth', async () => {
    const { path, state } = setup()
    const models = await discoverZCode(
      '/native/zcode',
      async () => {
        throw new Error('must not spawn')
      },
      state,
      '/missing-auth',
      path,
      { nativeHome: join(dirname(path), 'native-home') },
    )
    expect(models).toEqual([
      {
        id: `${route}/GLM-5.3-Flash`,
        label: `GLM-5.3-Flash（${route} · 本机目录）`,
        efforts: ['low', 'high', 'max'],
      },
      { id: `${route}/UNACCEPTED`, label: `UNACCEPTED（${route} · 本机目录）`, efforts: ['none', 'default'] },
    ])
    expect(existsSync(state)).toBe(false)
    const bad = builtin()
    bad.config.providerConfigRules.providerRules[0].config.builtinModelIds = ['UNACCEPTED']
    expect(parseZCodeBuiltin(bad).map((model) => model.id)).toEqual([`${route}/UNACCEPTED`])
    expect(() => parseZCodeBuiltin({ schemaVersion: 2 })).toThrow('schema')
  })
  it('applies matching API/site/exact overrides in native order and rejects disabled models', () => {
    const data: any = builtin()
    data.config.modelConfigRules.modelApiRules.push({
      modelMatch: '.*',
      apiTypeMatch: 'other',
      config: { enabled: false },
    })
    data.config.modelConfigRules.providerSiteRules.push({
      modelMatch: '.*',
      baseUrlMatch: 'https://example\\.test/api',
      config: { optionSpecs: { reasoningLevel: { values: ['medium'] } } },
    })
    data.config.modelConfigRules.builtinProviderModelRules.push({
      providerId: route,
      modelId: 'GLM-5.3-Flash',
      config: { optionSpecs: { reasoningLevel: { values: ['high'] } } },
    })
    expect(parseZCodeBuiltin(data)[0].efforts).toEqual(['high'])
    data.config.modelConfigRules.builtinProviderModelRules.push({
      providerId: route,
      modelId: 'GLM-5.3-Flash',
      config: { enabled: false },
    })
    expect(parseZCodeBuiltin(data).some((model) => model.id === `${route}/GLM-5.3-Flash`)).toBe(false)
  })

  it('inherits provider templates and uses exact case-sensitive template model IDs', () => {
    const data: any = builtin()
    data.config.providerConfigRules.templateRules = [
      {
        templateId: 'native-template',
        config: { api: data.config.providerConfigRules.providerRules[0].config.api },
      },
    ]
    data.config.providerConfigRules.providerRules[0].templateId = 'native-template'
    delete data.config.providerConfigRules.providerRules[0].config.api
    data.config.modelConfigRules.templateModelRules.push(
      {
        templateId: 'native-template',
        modelId: 'GLM-5.3-Flash',
        config: { optionSpecs: { reasoningLevel: { values: ['medium'] } } },
      },
      { templateId: 'native-template', modelId: 'glm-5.3-flash', config: { enabled: false } },
    )
    expect(parseZCodeBuiltin(data).find((model) => model.id === `${route}/GLM-5.3-Flash`)?.efforts).toEqual([
      'medium',
    ])
  })

  it('merges global and plugin personal interfaces and preserves private rules at execution', async () => {
    const f = setup(),
      global = personal(),
      plugin = personal()
    global.config.providerOrder = ['personal:external']
    global.config.providerConfigRules.providerRules.push({
      providerId: 'personal:external',
      config: {
        group: 'standard-personal',
        personalModelIds: ['custom/model-v1', 'second-model'],
        modelOrder: ['second-model', 'custom/model-v1'],
        api: {
          type: 'openai-chat-completions',
          baseUrl: 'https://example.test/v1',
          headers: { 'X-Synthetic': 'SYNTHETIC_SECRET' },
        },
        access: { type: 'api-key', apiKey: 'SYNTHETIC_SECRET' },
      },
    })
    global.config.modelConfigRules.providerModelRules.push({
      providerId: 'personal:external',
      modelId: 'custom/model-v1',
      config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['low'] } } },
    })
    plugin.config.providerConfigRules.providerRules.push({
      providerId: 'personal:external',
      config: { api: { baseUrl: 'https://example.test/override' } },
    })
    plugin.config.modelConfigRules.manualProviderModelRules.push({
      providerId: 'personal:external',
      modelId: 'custom/model-v1',
      config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['high'] } } },
    })
    const globalPath = savePersonal(f.input.nativeHome, global),
      pluginPath = savePersonal(f.input.authDirectory, plugin)
    const before = [readFileSync(globalPath, 'utf8'), readFileSync(pluginPath, 'utf8')]
    const capture = vi.fn(async () => {
      throw new Error('must not spawn')
    })
    const models = await discoverZCode(f.input.executable, capture, f.state, f.input.authDirectory, f.path, {
      nativeHome: f.input.nativeHome,
    })
    expect(
      models.some(
        (model) => model.id === 'personal:external/custom/model-v1' && model.efforts?.includes('high'),
      ),
    ).toBe(true)
    expect(JSON.stringify(models)).not.toContain('SYNTHETIC_SECRET')
    expect(capture).not.toHaveBeenCalled()
    const launch = await prepareZCode({
      ...f.input,
      preference: { model: 'personal:external/custom/model-v1', effort: 'high' },
    })
    const copy = JSON.parse(readFileSync(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8'))
    expect(copy.config.defaultModelSelection).toEqual({
      providerId: 'personal:external',
      modelId: 'custom/model-v1',
      options: { reasoningLevel: 'high' },
    })
    expect(copy.config.providerConfigRules.providerRules[0].config.api).toEqual({
      type: 'openai-chat-completions',
      baseUrl: 'https://example.test/override',
      headers: { 'X-Synthetic': 'SYNTHETIC_SECRET' },
    })
    expect(copy.config.providerConfigRules.providerRules[0].config.access.apiKey).toBe('SYNTHETIC_SECRET')
    expect(copy.config.providerOrder).toEqual(['personal:external'])
    expect(copy.config.modelConfigRules.providerModelRules).toEqual([])
    expect(copy.config.modelConfigRules.manualProviderModelRules).toEqual(
      plugin.config.modelConfigRules.manualProviderModelRules,
    )
    expect(statSync(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(launch)).not.toContain('SYNTHETIC_SECRET')
    expect([readFileSync(globalPath, 'utf8'), readFileSync(pluginPath, 'utf8')]).toEqual(before)
  })

  it('respects personal visibility, provider enablement, model order and exact overrides', () => {
    const data: any = builtin(),
      own = personal()
    own.config.providerConfigRules.providerRules.push(
      {
        providerId: route,
        config: {
          personalModelIds: ['private-extra'],
          modelOrder: ['private-extra', 'UNACCEPTED', 'GLM-5.3-Flash'],
        },
      },
      { providerId: 'hidden', config: { visibility: 'hidden', personalModelIds: ['hidden-model'] } },
      { providerId: 'disabled', enabled: false, config: { personalModelIds: ['disabled-model'] } },
    )
    own.config.modelConfigRules.providerModelRules.push({
      providerId: route,
      modelId: 'GLM-5.3-Flash',
      config: { enabled: false },
    })
    own.config.modelConfigRules.manualProviderModelRules.push({
      providerId: route,
      modelId: 'private-extra',
      config: { enabled: true },
    })
    const choices = parseZCodeBuiltin(data, own)
    expect(choices.map((choice) => choice.id)).toEqual([`${route}/private-extra`, `${route}/UNACCEPTED`])
    expect(choices[0].efforts).toEqual(['default'])
    own.config.providerConfigRules.providerRules[0].config.visibility = 'hidden'
    expect(parseZCodeBuiltin(data, own)).toEqual([])
  })

  it('uses native metadata default and disabled values in a private continuation request', async () => {
    const f = setup()
    const resumed = await prepareZCode({
      ...f.input,
      preference: { model: `${route}/UNACCEPTED`, effort: 'default' },
      conversationId: 'synthetic-existing',
    })
    const request = JSON.parse(readFileSync(resumed.argv[2], 'utf8'))
    expect(request.selection).toEqual({
      providerId: route,
      modelId: 'UNACCEPTED',
      options: { reasoningLevel: 'enabled' },
    })
    expect(request.argv).toContain('--resume')
    expect(request.argv).not.toContain('--model')
    const disabled = await prepareZCode({
      ...f.input,
      preference: { model: `${route}/UNACCEPTED`, effort: 'none' },
    })
    expect(
      JSON.parse(readFileSync(disabled.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8')).config
        .defaultModelSelection.options,
    ).toEqual({ reasoningLevel: 'disabled' })
  })

  it.each(['malformed', 'oversized', 'symlink', 'hardlink', 'directory-link'] as const)(
    'fails closed on %s personal sources without disclosing source content or starting a task',
    async (kind) => {
      const f = setup(),
        path = savePersonal(f.input.nativeHome, personal()),
        secret = join(f.root, 'private-source')
      writeFileSync(secret, 'SYNTHETIC_SECRET', { mode: 0o600 })
      if (kind === 'directory-link') {
        rmSync(dirname(path), { recursive: true })
        symlinkSync(f.root, dirname(path))
      } else if (kind === 'symlink' || kind === 'hardlink') {
        rmSync(path)
        if (kind === 'symlink') symlinkSync(secret, path)
        else linkSync(secret, path)
      } else
        writeFileSync(
          path,
          kind === 'malformed' ? 'SYNTHETIC_SECRET broken {' : 'SYNTHETIC_SECRET'.repeat(150000),
        )
      const capture = vi.fn(async () => '')
      const error = await discoverZCode(f.input.executable, capture, f.state, f.input.authDirectory, f.path, {
        nativeHome: f.input.nativeHome,
      }).catch((reason) => reason)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain('SYNTHETIC_SECRET')
      await expect(prepareZCode(f.input)).rejects.toThrow('个人模型配置')
      expect(capture).not.toHaveBeenCalled()
      expect(existsSync(f.state)).toBe(false)
    },
  )

  it('honors an explicit native personal path and rejects duplicate or unsupported personal schemas', async () => {
    const f = setup(),
      own = personal()
    own.config.modelConfigRules.providerModelRules.push({
      providerId: route,
      modelId: 'GLM-5.3-Flash',
      config: { enabled: false },
    })
    const path = savePersonal(join(f.root, 'explicit'), own)
    vi.stubEnv('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', path)
    const models = await discoverZCode(
      f.input.executable,
      async () => '',
      f.state,
      f.input.authDirectory,
      f.path,
    )
    expect(models.some((model) => model.id === `${route}/GLM-5.3-Flash`)).toBe(false)
    own.config.modelConfigRules.manualProviderModelRules.push({
      ...own.config.modelConfigRules.providerModelRules[0],
    })
    expect(() => parseZCodeBuiltin(builtin(), own)).toThrow('duplicate')
    expect(() => parseZCodeBuiltin(builtin(), { schemaVersion: 2 })).toThrow('schema')
    await expect(prepareZCode({ ...f.input, personalConfig: join(f.root, 'missing.json') })).rejects.toThrow(
      '个人模型配置',
    )
  })
})

describe('ZCode stream protocol (explicitly synthetic fixtures)', () => {
  it('rejects an observed model that differs from the exact selected native ID', () => {
    const parser = new ZCodeProtocol(
      () => undefined,
      () => undefined,
      8192,
      'personal:external/custom/model-v1',
    )
    expect(() =>
      parser.feed(
        JSON.stringify({
          type: 'session.updated',
          sessionId: 'synthetic-session',
          payload: { providerId: route, modelId: 'GLM-5.3-Flash' },
        }) + '\n',
      ),
    ).toThrow('不匹配')
    const selected = new ZCodeProtocol(
      () => undefined,
      () => undefined,
      8192,
      'personal:external/custom/model-v1',
    )
    expect(() =>
      selected.feed(
        JSON.stringify({
          type: 'session.updated',
          sessionId: 'synthetic-session',
          payload: { providerId: 'personal:external', modelId: 'custom/model-v1' },
        }) + '\n',
      ),
    ).not.toThrow()
  })
  it('frames split UTF-8, confirms the native model, and requires the final native result', () => {
    const f = fixture()
    const stream = [
      f.event('session.updated', { providerId: route, modelId: 'GLM-5.3-Flash' }),
      f.event('model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_fixture', delta: '完成' }),
      f.complete(),
    ]
    const bytes = Buffer.from(stream.map((v) => JSON.stringify(v)).join('\n') + '\n')
    for (let i = 0; i < bytes.length; i += 7) f.parser.feed(bytes.subarray(i, i + 7))
    expect(f.parser.result).toBeUndefined()
    f.parser.feed(JSON.stringify(f.result()))
    f.parser.end()
    expect(f.parser.result).toMatchObject({
      conversationId: 'sess_fixture',
      status: 'SUCCESS',
      response: '完成',
    })
    expect(f.ids).toEqual(['sess_fixture'])
    expect(f.events.find((v) => v.kind === 'assistant')?.text).toBe('完成')
    expect(f.events.find((v) => v.kind === 'status')?.observedModel).toBe(`${route}/GLM-5.3-Flash`)
  })
  it('keeps a successful real tool identity through scheduled, started, result and batch', () => {
    const f = fixture()
    f.send(
      f.event('tool.updated', { kind: 'scheduled', toolCallId: 'call_fixture', toolName: 'Write' }),
      f.event('tool.updated', { kind: 'started', toolCallId: 'call_fixture', toolName: 'Write' }),
      f.event('tool.updated', { kind: 'result', toolCallId: 'call_fixture', result: { success: true } }),
      f.event('tool.updated', { kind: 'batch', successCount: 1, errorCount: 0 }),
      f.complete(),
      f.result(),
    )
    expect(f.parser.result?.status).toBe('SUCCESS')
    expect(f.events.filter((v) => v.kind === 'tool').map((v) => [v.text, v.step, v.state])).toEqual([
      ['Write', 0, 'RUNNING'],
      ['Write', 0, 'RUNNING'],
      ['Write', 0, 'COMPLETED'],
    ])
  })
  it.each(['permission', 'batch', 'result', 'unfinished'])(
    'does not erase %s failure when the native turn says success',
    (failure) => {
      const f = fixture()
      if (failure !== 'batch')
        f.send(f.event('tool.updated', { kind: 'scheduled', toolCallId: 'call_fixture', toolName: 'Write' }))
      if (failure === 'permission')
        f.send(
          f.event('permission.resolved', { toolCallId: 'call_fixture', decision: 'deny' }),
          f.event('tool.updated', { kind: 'batch', errorCount: 1 }),
        )
      if (failure === 'batch') f.send(f.event('tool.updated', { kind: 'batch', errorCount: 1 }))
      if (failure === 'result')
        f.send(
          f.event('tool.updated', { kind: 'result', toolCallId: 'call_fixture', result: { success: false } }),
        )
      f.send(f.complete(), f.result())
      expect(f.parser.result?.status).toBe('ERROR')
    },
  )
  it('does not infer success from EOF, final text alone or failed turns', () => {
    const empty = fixture()
    empty.parser.end()
    expect(empty.parser.result).toBeUndefined()
    const cancelled = fixture()
    cancelled.send(
      cancelled.event('model.streaming', { kind: 'text_delta', assistantMessageId: 'msg', delta: 'partial' }),
    )
    cancelled.parser.end()
    expect(cancelled.parser.result).toBeUndefined()
    const noTerminal = fixture()
    noTerminal.send(noTerminal.result())
    expect(noTerminal.parser.result?.status).toBe('ERROR')
    const failed = fixture()
    failed.send(
      failed.event('turn.failed', { message: 'synthetic error' }),
      failed.complete(),
      failed.result(),
    )
    expect(failed.parser.result?.status).toBe('ERROR')
  })
  it('rejects malformed events, missing identities, changed sessions and oversized lines', () => {
    for (const invalid of [null, [], 'value', { type: 'result', response: 'text' }])
      expect(() => fixture().send(invalid)).toThrow()
    const changed = fixture()
    changed.send(changed.event('session.updated'))
    expect(() => changed.send({ type: 'session.updated', sessionId: 'other' })).toThrow('session changed')
    expect(() => fixture(5).parser.feed('123456')).toThrow('too large')
    expect(() => fixture().parser.feed('{oops}\n')).toThrow('Invalid ZCode')
    const terminal = fixture()
    terminal.send(terminal.complete(), terminal.result())
    expect(() => terminal.send(terminal.complete())).toThrow('Unexpected')
    const ended = fixture()
    ended.parser.end()
    expect(() => ended.parser.feed('x')).toThrow('already ended')
  })
})
