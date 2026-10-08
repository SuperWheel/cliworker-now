import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import {
  discoverHermes,
  hermesTokenUsage,
  hermesHomeDirectory,
  HermesProtocol,
  parseHermesRecord,
  prepareHermes,
  validateHermesHomeDirectory,
} from '../src/host/hermes-adapter.ts'
import type { EventInput } from '../src/host/protocol.ts'
import { foldEvents } from '../src/shared/types.ts'

vi.mock('../src/host/hermes-installation.ts', () => ({ verifyHermesExecutable: async () => undefined }))
vi.mock('../src/host/hermes-models.ts', async (load) => ({
  ...(await load<typeof import('../src/host/hermes-models.ts')>()),
  hermesAccountModels: vi.fn(async () => ({
    state: 'supported',
    source: 'account-models',
    models: [{ id: 'synthetic/model', cost: 'unknown' }],
  })),
}))
// Synthetic supported account metadata; credential/HTTP boundaries have a separate suite.
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'hermes-fixture-'))
  directories.push(path)
  return path
}
function home(provider = 'openrouter') {
  const path = directory()
  writeFileSync(
    join(path, 'config.yaml'),
    `auth:\n  adopt_external_logins: false\nmodel:\n  provider: ${provider}\n  default: synthetic/model\n`,
    {
      mode: 0o600,
    },
  )
  return path
}
function capabilities(
  path: string,
  values: unknown,
  providerUrl = 'https://openrouter.ai/api/v1/models',
  ts = Date.now() / 1000,
) {
  mkdirSync(join(path, 'cache'), { recursive: true })
  writeFileSync(
    join(path, 'cache/reasoning_caps.json'),
    JSON.stringify({
      [providerUrl]: {
        ts,
        caps: {
          'synthetic/model': { supports_reasoning: true, supported_efforts: values },
        },
      },
    }),
  )
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(maxLineBytes = 8192) {
  const events: EventInput[] = [],
    ids: string[] = []
  const parser = new HermesProtocol(
    (event) => events.push(event),
    (id) => ids.push(id),
    maxLineBytes,
  )
  const send = (...events: unknown[]) =>
    parser.feed(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const init = { type: 'system', subtype: 'init', session_id: 'synthetic-session', model: 'synthetic/model' }
  const result = {
    type: 'result',
    session_id: 'synthetic-session',
    exit_code: 0,
    text: '完成',
    tokens: { input: 10, output: 2, total: 12, cache_read: 0, cache_write: 0 },
    duration_ms: 10,
  }
  return { parser, events, ids, send, init, result }
}

describe('Hermes adapter (synthetic fixtures; no inference)', () => {
  it('reads only native scalar model/provider settings and preserves the account home', async () => {
    const hermesHome = home()
    capabilities(hermesHome, ['low', 'high', 'high', 'invented'])
    const calls: string[][] = []
    const models = await discoverHermes(
      '/bin/hermes',
      async (argv, env) => {
        calls.push(argv)
        expect(env?.HERMES_HOME).toBe(realpathSync(hermesHome))
        expect(argv.slice(1, 3)).toEqual(['config', 'get'])
        expect(argv.at(-1)).toBe('--json')
        return JSON.stringify(argv[3] === 'model.default' ? 'synthetic/model' : 'openrouter')
      },
      directory(),
      hermesHome,
    )
    expect(calls.map((args) => args[3]).sort()).toEqual(['model.default', 'model.provider'])
    expect(models).toEqual([
      {
        id: '["openrouter","synthetic/model"]',
        label: 'synthetic/model',
        cost: 'unknown',
        efforts: ['default', 'low', 'high'],
      },
    ])
  })

  it('does not continue scalar discovery after caller cancellation', async () => {
    const controller = new AbortController(),
      calls: string[][] = []
    await expect(
      discoverHermes(
        '/bin/hermes',
        async (argv) => {
          calls.push(argv)
          controller.abort(new Error('synthetic metadata cancelled'))
          return JSON.stringify('synthetic/model')
        },
        directory(),
        home(),
        { signal: controller.signal },
      ),
    ).rejects.toThrow('synthetic metadata cancelled')
    expect(calls).toHaveLength(1)
  })

  it('does not invent choices for missing, stale, other-provider or ambiguous capabilities', async () => {
    for (const scenario of ['missing', 'stale', 'other-provider', 'other-url', 'unknown-efforts']) {
      const hermesHome = home()
      if (scenario !== 'missing')
        capabilities(
          hermesHome,
          scenario === 'unknown-efforts' ? null : ['high'],
          scenario === 'other-url' ? 'https://example.invalid/models' : undefined,
          scenario === 'stale' ? 1 : undefined,
        )
      const model = (
        await discoverHermes(
          '/bin/hermes',
          async (argv) =>
            JSON.stringify(
              argv[3] === 'model.default'
                ? 'synthetic/model'
                : scenario === 'other-provider'
                  ? 'custom-provider'
                  : 'openrouter',
            ),
          directory(),
          hermesHome,
        )
      )[0]
      expect(model?.efforts, scenario).toEqual(['default'])
    }
  })

  it('does not launch any query or invent a model before native setup', async () => {
    let calls = 0
    await expect(
      discoverHermes(
        '/bin/hermes',
        async () => {
          calls++
          return 'null'
        },
        directory(),
        directory(),
      ),
    ).rejects.toThrow('登录设置')
    expect(calls).toBe(0)
    await expect(
      discoverHermes('/bin/hermes', async () => JSON.stringify('auto'), directory(), home()),
    ).rejects.toThrow('明确选择')
  })

  it('uses only Hermes flags, a literal prompt, native resume, and no shared provider credentials', async () => {
    const hermesHome = home(),
      project = directory(),
      stateDirectory = directory()
    capabilities(hermesHome, ['low', 'high'])
    const before = readFileSync(join(hermesHome, 'config.yaml'), 'utf8')
    const input = {
      executable: '/bin/hermes',
      project,
      stateDirectory,
      hermesHome,
      preference: { model: '["openrouter","synthetic/model"]', effort: 'low' as const },
      mode: 'plan' as const,
      prompt: '$(touch nope); `echo unsafe`\n你好',
      conversationId: 'existing-native-session',
    }
    const result = await prepareHermes(input)
    expect(result.argv).toEqual([
      '/bin/hermes',
      '--in',
      project,
      'chat',
      '--format',
      'stream-json',
      '--model',
      'synthetic/model',
      '--provider',
      'openrouter',
      '--toolsets',
      'terminal,file',
      '--ignore-rules',
      '--reasoning',
      'low',
      '--resume',
      'existing-native-session',
      '-q',
      input.prompt,
    ])
    expect(result.env.HERMES_HOME).toBe(realpathSync(hermesHome))
    expect(result.env.HERMES_YOLO_MODE).toBe('0')
    expect(result.env.HERMES_SAFE_MODE).toBe('1')
    expect(Object.keys(result.env).some((key) => /API_KEY|CREDENTIAL|DSH_/.test(key))).toBe(false)
    expect(statSync(result.env.TMPDIR!).mode & 0o077).toBe(0)
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')).toBe(before)
    const defaults = await prepareHermes({
      ...input,
      mode: 'accept-edits',
      preference: { ...input.preference, effort: 'default' },
    })
    expect(defaults.argv).not.toContain('--reasoning')
    expect(defaults.argv).not.toContain('--plan')
    expect(defaults.argv).not.toContain('--yolo')
    expect(defaults.argv).not.toContain('--safe-mode')
    await expect(
      prepareHermes({ ...input, preference: { ...input.preference, effort: 'ultra' } }),
    ).rejects.toThrow('思考强度')
  })

  it('rejects symlinked configuration and isolated state paths without writing through them', async () => {
    const native = home(),
      linked = join(directory(), 'native')
    symlinkSync(native, linked)
    await expect(discoverHermes('/bin/hermes', async () => 'null', directory(), linked)).rejects.toThrow(
      'Unsafe',
    )
    const stateDirectory = directory(),
      target = directory()
    symlinkSync(target, join(stateDirectory, 'hermes'))
    await expect(
      prepareHermes({
        executable: '/bin/hermes',
        project: directory(),
        stateDirectory,
        hermesHome: native,
        preference: { model: '["openrouter","synthetic/model"]', effort: 'default' },
        mode: 'plan',
        prompt: 'fixture',
      }),
    ).rejects.toThrow('Unsafe')
  })

  it('refuses root, user home, ancestors, and parent aliases that canonicalize to broad write scopes', async () => {
    const userHome = realpathSync(homedir()),
      root = parse(userHome).root
    for (const dangerous of [root, userHome, dirname(userHome)]) {
      expect(() => validateHermesHomeDirectory(dangerous)).toThrow('Unsafe Hermes home')
      let queried = false
      await expect(
        discoverHermes(
          '/fixture/hermes',
          async () => {
            queried = true
            return 'null'
          },
          directory(),
          dangerous,
        ),
      ).rejects.toThrow('Unsafe Hermes home')
      expect(queried).toBe(false)
    }
    const aliasParent = directory(),
      alias = join(aliasParent, 'system-root')
    symlinkSync(root, alias)
    const homeViaParentLink = join(alias, userHome.slice(root.length))
    expect(() => hermesHomeDirectory(homeViaParentLink)).toThrow('Unsafe Hermes home')
    expect(() => hermesHomeDirectory(join(alias, dirname(userHome).slice(root.length)))).toThrow(
      'Unsafe Hermes home',
    )
  })

  it('canonicalizes safe parent aliases and nonexistent dedicated homes without granting the parent itself', async () => {
    const parent = directory(),
      alias = join(directory(), 'safe-parent')
    symlinkSync(parent, alias)
    expect(validateHermesHomeDirectory(join(alias, 'new-native-home'))).toBe(
      join(realpathSync(parent), 'new-native-home'),
    )
    const native = join(parent, 'native')
    mkdirSync(native)
    writeFileSync(
      join(native, 'config.yaml'),
      'auth:\n  adopt_external_logins: false\nmodel:\n  provider: openrouter\n  default: synthetic/model\n',
    )
    const models = await discoverHermes(
      '/fixture/hermes',
      async (argv, env) => {
        expect(env?.HERMES_HOME).toBe(realpathSync(native))
        return JSON.stringify(argv[3] === 'model.default' ? 'synthetic/model' : 'openrouter')
      },
      directory(),
      join(alias, 'native'),
    )
    expect(models[0]?.id).toBe('["openrouter","synthetic/model"]')
  })

  it('streams split UTF-8 and preserves tool start/result identities without duplicating final text', () => {
    const f = fixture()
    f.send(
      f.init,
      { type: 'tool_use', name: 'read_file', input: { path: 'file' }, tool_call_id: 'tool-1' },
      {
        type: 'tool_result',
        name: 'read_file',
        tool_call_id: 'tool-1',
        output: 'read',
        is_error: false,
        duration_ms: 1,
      },
    )
    const chunk = Buffer.from(JSON.stringify({ type: 'text', text: '完成' }) + '\n')
    for (const byte of chunk) f.parser.feed(Buffer.from([byte]))
    f.send(f.result)
    expect(f.parser.result).toBeUndefined()
    f.parser.end()
    expect(f.parser.result).toEqual({
      conversationId: 'synthetic-session',
      status: 'SUCCESS',
      response: '完成',
    })
    expect(f.events.filter((event) => event.kind === 'assistant').map((event) => event.text)).toEqual([
      '完成',
    ])
    expect(f.events.filter((event) => event.kind === 'tool').map((event) => event.step)).toEqual([1, 1])
    expect(f.ids).toEqual(['synthetic-session'])
  })

  it('folds native text deltas into one response and reuses that segment for final correction', () => {
    const f = fixture()
    const timeline = () =>
      foldEvents(
        f.events.map((event, seq) => ({
          ...event,
          seq,
          runId: 'synthetic-run',
          time: '2026-10-06T00:00:00.000Z',
        })),
      ).filter((row) => row.kind === 'assistant')
    f.send(
      f.init,
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'wor' },
      { type: 'text', text: '' },
      { type: 'text', text: 'ld' },
    )
    expect(timeline().map((row) => row.text)).toEqual(['Hello world'])
    expect(f.events.filter((event) => event.kind === 'assistant').map((event) => event.step)).toEqual([
      1, 1, 1, 1,
    ])
    f.send({ ...f.result, text: 'Hello world!' })
    f.parser.end()
    expect(timeline().map((row) => row.text)).toEqual(['Hello world!'])
    expect(f.events.filter((event) => event.kind === 'assistant')).toHaveLength(4)
    expect(f.events.at(-1)?.step).toBe(1)
  })

  it('opens a new response segment after tools while preserving all streamed chunks', () => {
    const f = fixture()
    f.send(
      f.init,
      { type: 'text', text: 'Checking' },
      { type: 'text', text: ' now.' },
      { type: 'tool_use', name: 'read_file', tool_call_id: 'read' },
      {
        type: 'tool_result',
        name: 'read_file',
        tool_call_id: 'read',
        output: 'ok',
        is_error: false,
        duration_ms: 1,
      },
      { type: 'text', text: 'All ' },
      { type: 'text', text: 'done.' },
      { ...f.result, text: 'All done.' },
    )
    f.parser.end()
    const rows = foldEvents(
      f.events.map((event, seq) => ({
        ...event,
        seq,
        runId: 'synthetic-run',
        time: '2026-10-06T00:00:00.000Z',
      })),
    ).filter((row) => row.kind !== 'status')
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ['assistant', 'Checking now.'],
      ['tool', 'read_file'],
      ['assistant', 'All done.'],
    ])
    expect(f.events.filter((event) => event.kind === 'assistant').map((event) => event.step)).toEqual([
      1, 1, 2, 2,
    ])
    expect(f.events.at(-1)?.step).toBe(2)
  })

  it('places an unstreamed final answer after its tool without overwriting an earlier response', () => {
    const f = fixture()
    f.send(
      f.init,
      { type: 'text', text: 'Checking now.' },
      { type: 'tool_use', name: 'read_file', tool_call_id: 'read' },
      {
        type: 'tool_result',
        name: 'read_file',
        tool_call_id: 'read',
        output: 'ok',
        is_error: false,
        duration_ms: 1,
      },
      f.result,
    )
    f.parser.end()
    const rows = foldEvents(
      f.events.map((event, seq) => ({
        ...event,
        seq,
        runId: 'synthetic-run',
        time: '2026-10-06T00:00:00.000Z',
      })),
    ).filter((row) => row.kind !== 'status')
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ['assistant', 'Checking now.'],
      ['tool', 'read_file'],
      ['assistant', '完成'],
    ])
  })

  it('accepts optional native tool IDs only when their matching is unambiguous', () => {
    const f = fixture()
    f.send(
      f.init,
      { type: 'tool_use', name: 'read_file' },
      { type: 'tool_result', name: 'read_file', output: 'ok', is_error: false, duration_ms: 1 },
      f.result,
    )
    f.parser.end()
    expect(f.parser.result?.status).toBe('SUCCESS')
    const g = fixture()
    g.send(g.init, { type: 'tool_use', name: 'read_file' })
    expect(() => g.send({ type: 'tool_use', name: 'read_file' })).toThrow('Ambiguous')
    const h = fixture()
    h.send(h.init)
    expect(() =>
      h.send({ type: 'tool_result', name: 'read_file', output: 'orphan', is_error: false, duration_ms: 1 }),
    ).toThrow('Unmatched')
  })

  it('honors the terminal run outcome after failed or incomplete tool-progress callbacks', () => {
    for (const scenario of ['missing', 'pending', 'error', 'tool-error']) {
      const f = fixture()
      f.send(f.init)
      if (scenario === 'pending' || scenario === 'tool-error')
        f.send({ type: 'tool_use', name: 'terminal', tool_call_id: 'one' })
      if (scenario === 'tool-error')
        f.send({
          type: 'tool_result',
          name: 'terminal',
          tool_call_id: 'one',
          output: 'denied',
          is_error: true,
          duration_ms: 1,
        })
      if (scenario !== 'missing')
        f.send({
          ...f.result,
          ...(scenario === 'error' ? { exit_code: 1, error: 'authentication failed' } : {}),
        })
      f.parser.end()
      expect(f.parser.result?.status, scenario).toBe(
        scenario === 'error' || scenario === 'missing' ? 'ERROR' : 'SUCCESS',
      )
      if (scenario === 'tool-error')
        expect(f.events.filter((event) => event.kind === 'tool').at(-1)?.state).toBe('failed')
      if (scenario === 'pending')
        expect(f.events.filter((event) => event.kind === 'tool').at(-1)?.state).toBe('running')
    }
  })

  it('maps real native run counters without treating cache counters as extra usage or context', () => {
    expect(hermesTokenUsage({ input: 10, output: 2, total: 12, cache_read: 4, cache_write: 1 })).toEqual({
      input: 10,
      output: 2,
      total: 12,
      cacheRead: 4,
      scope: 'run',
    })
    expect(hermesTokenUsage({ total: 0 })).toMatchObject({ total: 0, scope: 'run' })
    expect(hermesTokenUsage({ input: 100, output: 2 })).toBeUndefined()
    expect(hermesTokenUsage({ total: -1 })).toBeUndefined()
    expect(hermesTokenUsage({ total: 1.5 })).toBeUndefined()
    expect(hermesTokenUsage({ total: '100' })).toBeUndefined()
  })

  it('rejects identity changes, duplicate init, out-of-order and trailing records', () => {
    const f = fixture()
    expect(() => f.send(f.result)).toThrow('identity')
    const g = fixture()
    g.send(g.init)
    expect(() => g.send({ ...g.result, session_id: 'another' })).toThrow('identity changed')
    const h = fixture()
    h.send(h.init)
    expect(() => h.send(h.init)).toThrow('Duplicate')
    const i = fixture()
    i.send(i.init, i.result)
    expect(() => i.send({ type: 'text', text: 'late' })).toThrow('after Hermes result')
  })

  it('rejects malformed frames and caps unterminated or completed line size', () => {
    expect(() => parseHermesRecord({ type: 'result', session_id: 'x', text: '', exit_code: '0' })).toThrow(
      'Invalid',
    )
    expect(() => parseHermesRecord({ type: 'thought', text: 'not part of native protocol' })).toThrow(
      'Invalid',
    )
    expect(() => fixture(10).parser.feed('x'.repeat(11))).toThrow('maxLineBytes')
    expect(() => fixture(10).parser.feed('x'.repeat(11) + '\n')).toThrow('maxLineBytes')
    expect(() => fixture().parser.feed('plain CLI diagnostic\n')).toThrow()
  })
})
