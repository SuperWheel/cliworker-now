import { afterEach, describe, expect, it } from 'vitest'
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
import type { EventInput } from '../src/host/protocol.ts'

const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'opencode-adapter-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const fixtureModel = (variants = {}) =>
  'fixture/model\n' +
  JSON.stringify({ providerID: 'fixture', id: 'model', name: 'Synthetic model', variants }, null, 2) +
  '\n'
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
    expect(readFileSync(prepared.env.OPENCODE_CONFIG!, 'utf8')).toBe('{}\n')
  })
  it('accepts edits but preserves additional approval and the explicit native effort', async () => {
    const prepared = await prepareOpenCode({
      executable: '/bin/opencode',
      project: '/project',
      preference: { model: 'fixture/model', effort: 'low' },
      mode: 'accept-edits',
      prompt: 'test',
      stateDirectory: directory(),
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
      preference: { model: 'fixture/model', effort: 'default' },
      mode: 'plan',
      prompt: 'synthetic read only task',
    })
    expect(readFileSync(outside, 'utf8')).toBe('SENTINEL')
    expect(statSync(outside).mode).toBe(before)
    expect(lstatSync(config).isSymbolicLink()).toBe(false)
    expect(readFileSync(prepared.env.OPENCODE_CONFIG!, 'utf8')).toBe('{}\n')
    expect(statSync(config).mode & 0o777).toBe(0o600)
  })
  it('queries native catalogue without a prompt and never guesses variants', async () => {
    const calls: unknown[] = []
    const models = await discoverOpenCode(
      '/bin/opencode',
      async (argv, env) => {
        calls.push({ argv, env })
        return fixtureModel({ low: {}, max: {}, fictional: {} })
      },
      directory(),
    )
    expect((calls[0] as any).argv).toEqual(['/bin/opencode', 'models', '--verbose'])
    expect(models).toEqual([
      { id: 'fixture/model', label: 'Synthetic model', efforts: ['default', 'low', 'max'] },
    ])
    expect(parseOpenCodeModels(fixtureModel())[0]?.efforts).toEqual(['default'])
    expect(() => parseOpenCodeModels(fixtureModel().replace('fixture/model', 'other/model'))).toThrow(
      /identity/,
    )
    expect(() => parseOpenCodeModels('fixture/model\n{')).toThrow(/Incomplete/)
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
