import { afterEach, describe, expect, it } from 'vitest'
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
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    },
  }
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
    expect(launch.argv).toEqual([
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
    const denied = launch.argv[launch.argv.indexOf('--disallowedTools') + 1].split(',')
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
    ).toBeUndefined()
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
  it('reads only the accepted installed route with native regex matching; never spawns or reads auth', async () => {
    const { path, state } = setup()
    const models = await discoverZCode(
      '/native/zcode',
      async () => {
        throw new Error('must not spawn')
      },
      state,
      '/missing-auth',
      path,
    )
    expect(models).toEqual([
      {
        id: `${route}/GLM-5.3-Flash`,
        label: 'GLM-5.3-Flash（本机配套目录）',
        efforts: ['low', 'high', 'max'],
      },
    ])
    expect(existsSync(state)).toBe(false)
    const bad = builtin()
    bad.config.providerConfigRules.providerRules[0].config.builtinModelIds = ['UNACCEPTED']
    expect(() => parseZCodeBuiltin(bad)).toThrow('does not enable')
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
    expect(() => parseZCodeBuiltin(data)).toThrow('no supported')
  })
})

describe('ZCode stream protocol (explicitly synthetic fixtures)', () => {
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
