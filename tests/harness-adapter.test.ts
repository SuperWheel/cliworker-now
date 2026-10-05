import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverHarness, HarnessProtocol, prepareHarness } from '../src/host/harness-adapter.ts'
import type { EventInput } from '../src/host/protocol.ts'
const directories: string[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-adapter-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const model = '["zai-coding-cn","glm-5.3-flash"]'
function fixture(max = 8192) {
  const events: EventInput[] = [],
    ids: string[] = []
  const parser = new HarnessProtocol(
    (e) => events.push(e),
    (id) => ids.push(id),
    max,
  )
  const send = (...e: unknown[]) => parser.feed(e.map((x) => JSON.stringify(x)).join('\n') + '\n')
  const session = { type: 'session', sessionId: 'session-fixture' }
  const complete = { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }
  return { parser, send, session, complete, events, ids }
}
describe('Harness adapter (explicitly synthetic protocol fixtures)', () => {
  it('uses native headless and private persistent project state without copying credentials', async () => {
    const stateDirectory = directory(),
      project = directory(),
      prompt = '$(touch nope); `echo unsafe`\n第二行'
    const input = {
      executable: '/bin/dsh',
      project,
      preference: { model, effort: 'low' as const },
      mode: 'accept-edits' as const,
      prompt,
      stateDirectory,
    }
    const first = await prepareHarness(input)
    const resumed = await prepareHarness({ ...input, conversationId: 'session-fixture' })
    expect(first.argv.at(-1)).toBe('任务：\n' + prompt)
    expect(first.argv.slice(0, 3)).toEqual(['/bin/dsh', '--profile', 'headless'])
    expect(resumed.argv).toContain('--session-id')
    expect(resumed.argv).toContain('session-fixture')
    expect(first.env.DSH_HOME).toBe(resumed.env.DSH_HOME)
    expect(first.env.DSH_PERMISSION_MODE).toBe('workspace-write')
    expect(first.env).not.toHaveProperty('ZAI_CODING_CN_API_KEY')
    const overlay = first.argv[first.argv.indexOf('--patch') + 1]!
    const patch = JSON.parse(readFileSync(overlay, 'utf8'))
    expect(patch).toContainEqual({
      id: 'agent-default-model',
      config: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'low' },
    })
    expect(patch).toContainEqual({ id: 'session-title-llm', disabled: true })
    expect(JSON.stringify(patch)).not.toContain('.credentials')
    expect(statSync(overlay).mode & 0o077).toBe(0)
    expect(statSync(first.env.DSH_HOME!).mode & 0o077).toBe(0)
    expect(first.env.TMPDIR!.startsWith(realpathSync(stateDirectory) + '/')).toBe(true)
    const read = await prepareHarness({ ...input, mode: 'plan' })
    expect(read.env.DSH_PERMISSION_MODE).toBe('read-only')
  })
  it('rejects a provider substitution and unsafe state symlink', async () => {
    const stateDirectory = directory(),
      project = directory()
    const input = {
      executable: '/bin/dsh',
      project,
      preference: { model, effort: 'low' as const },
      mode: 'plan' as const,
      prompt: 'read',
      stateDirectory,
    }
    await expect(
      prepareHarness({ ...input, preference: { ...input.preference, model: '["other","model"]' } }),
    ).rejects.toThrow('zai-coding-cn')
    symlinkSync(directory(), join(stateDirectory, 'harness'))
    await expect(prepareHarness(input)).rejects.toThrow('symlink')
  })
  it('queries ACP without a prompt and retains exact native IDs/efforts', async () => {
    const models = [
      { id: model, label: 'Synthetic native model', efforts: ['default', 'low', 'high', 'max'] },
    ]
    const result = await discoverHarness(
      '/bin/dsh',
      async (argv, env) => {
        expect(argv[1]).toMatch(/harness-catalog\.mjs$/)
        expect(argv).not.toContain('--json')
        expect(argv).not.toContain('--single')
        expect(env?.DSH_PERMISSION_MODE).toBe('read-only')
        expect(env).not.toHaveProperty('ZAI_CODING_CN_API_KEY')
        return JSON.stringify(models)
      },
      directory(),
    )
    expect(result).toEqual(models)
    await expect(
      discoverHarness(
        '/bin/dsh',
        async () => JSON.stringify([{ ...models[0], efforts: ['fictional'] }]),
        directory(),
      ),
    ).rejects.toThrow('efforts')
  })
  it('performs real bridge IPC against a synthetic ACP executable, without any prompt', () => {
    const root = directory(),
      cli = join(root, 'fake-dsh.mjs'),
      log = join(root, 'rpc.log')
    writeFileSync(
      cli,
      `#!/usr/bin/env node
import fs from 'node:fs';import readline from 'node:readline';
const options=(value='["zai-coding-cn","fixture"]')=>[{id:'model',currentValue:value,options:[{group:'zai-coding-cn',options:[{value,name:'Synthetic model'}]}]},{id:'reasoning_effort',options:[{value:''},{value:'off'},{value:'low'}]}];
const reader=readline.createInterface({input:process.stdin});
reader.on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(q)+'\\n',{mode:0o600});
let result;if(q.method==='initialize')result={protocolVersion:1};else if(q.method==='session/new')result={sessionId:'catalog-fixture',configOptions:options()};else if(q.method==='session/set_config_option')result={configOptions:options(q.params.value)};else if(q.method==='session/close')result={};else process.exit(20);
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});
reader.on('close',()=>process.exit(0));\n`,
      { mode: 0o700 },
    )
    const output = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../src/host/harness-catalog.mjs', import.meta.url)),
        cli,
        join(root, 'overlay.yml'),
        root,
      ],
      { encoding: 'utf8', timeout: 5000 },
    )
    expect(output.status, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual([
      {
        id: '["zai-coding-cn","fixture"]',
        label: 'Synthetic model（智谱 Coding CN）',
        efforts: ['default', 'none', 'low'],
      },
    ])
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x).method),
    ).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/close'])
  })
  it('translates native off reasoning without inventing a provider default', async () => {
    const project = directory(),
      stateDirectory = directory()
    for (const effort of ['none', 'default'] as const) {
      const launch = await prepareHarness({
        executable: '/bin/dsh',
        project,
        stateDirectory,
        preference: { model, effort },
        mode: 'plan',
        prompt: 'read',
      })
      const patch = JSON.parse(readFileSync(launch.argv[launch.argv.indexOf('--patch') + 1]!, 'utf8'))
      const selected = patch.find((x: { id: string }) => x.id === 'agent-default-model').config
      if (effort === 'none') expect(selected.reasoningEffort).toBe('off')
      else expect(selected).not.toHaveProperty('reasoningEffort')
    }
  })
  it('requires matched tool results and both completed status plus final', () => {
    const f = fixture()
    f.send(
      f.session,
      { type: 'tool_call', callId: 'c1', tool: 'write', input: { content: 'fixture' } },
      { type: 'tool_result', callId: 'c1', status: 'completed', result: 'written' },
      f.complete,
      { type: 'final', text: 'done' },
    )
    expect(f.parser.result).toBeUndefined()
    f.parser.end()
    expect(f.parser.result).toEqual({
      conversationId: 'session-fixture',
      status: 'SUCCESS',
      response: 'done',
    })
    expect(f.events.filter((x) => x.kind === 'tool').map((x) => [x.step, x.state])).toEqual([
      [1, 'running'],
      [1, 'completed'],
    ])
    expect(f.ids).toEqual(['session-fixture'])
  })
  it('never promotes a tool denial, cancellation flush or missing terminal to success', () => {
    for (const variant of ['denied', 'cancelled', 'missing-final', 'in-flight'] as const) {
      const f = fixture()
      f.send(f.session)
      if (variant === 'denied' || variant === 'in-flight')
        f.send({ type: 'tool_call', callId: 'c', tool: 'write', input: {} })
      if (variant === 'denied')
        f.send({ type: 'tool_result', callId: 'c', status: 'error', result: 'sandbox denied' })
      if (variant !== 'cancelled') f.send(f.complete)
      if (variant !== 'missing-final') f.send({ type: 'final', text: '' })
      f.parser.end()
      expect(f.parser.result?.status).toBe('ERROR')
    }
    const noId = fixture()
    noId.send(noId.complete, { type: 'final', text: 'done' })
    noId.parser.end()
    expect(noId.parser.result).toBeUndefined()
  })
  it('latches native errors even if a later completed event arrives', () => {
    const f = fixture()
    f.send(f.session, { type: 'error', message: 'rejected' }, f.complete, { type: 'final', text: 'done' })
    f.parser.end()
    expect(f.parser.result?.status).toBe('ERROR')
    expect(f.parser.result?.error).toBe('rejected')
  })
  it('rejects mismatched IDs, unmatched tool results and post-final events', () => {
    const f = fixture()
    f.send(f.session)
    expect(() => f.send({ type: 'session', sessionId: 'other' })).toThrow('identity changed')
    const g = fixture()
    expect(() => g.send({ type: 'tool_result', callId: 'missing', status: 'completed' })).toThrow('Unmatched')
    const h = fixture()
    h.send(h.session, h.complete, { type: 'final', text: '' })
    expect(() => h.send({ type: 'text', text: 'late' })).toThrow('after Harness final')
  })
  it('handles split UTF-8, omits thinking and limits both complete and partial frames', () => {
    const f = fixture()
    const bytes = Buffer.from(
      [
        f.session,
        { type: 'thinking', text: 'private reasoning' },
        { type: 'text', text: '中文' },
        f.complete,
        { type: 'final', text: '中文' },
      ]
        .map(JSON.stringify)
        .join('\n'),
    )
    for (const b of bytes) f.parser.feed(Buffer.from([b]))
    f.parser.end()
    expect(f.parser.result?.response).toBe('中文')
    expect(JSON.stringify(f.events)).not.toContain('private reasoning')
    expect(f.events.filter((x) => x.kind === 'assistant')).toHaveLength(1)
    expect(() => fixture(32).parser.feed('x'.repeat(33))).toThrow('maxLineBytes')
    expect(() => fixture(32).send({ type: 'text', text: 'x'.repeat(40) })).toThrow('maxLineBytes')
  })
})
