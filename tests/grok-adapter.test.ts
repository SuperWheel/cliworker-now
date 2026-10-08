import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverGrok, GrokProtocol, prepareGrok } from '../src/host/grok-adapter.ts'
import type { EventInput } from '../src/host/protocol.ts'
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'grok-adapter-'))
  directories.push(path)
  return path
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture(max = 8192) {
  const events: EventInput[] = [],
    ids: string[] = []
  const parser = new GrokProtocol(
    (e) => events.push(e),
    (id) => ids.push(id),
    max,
  )
  const send = (...e: unknown[]) => parser.feed(e.map((x) => JSON.stringify(x)).join('\n') + '\n')
  const end = { type: 'end', stopReason: 'end_turn', sessionId: 'fixture-session' }
  return { parser, send, end, events, ids }
}
describe('Grok adapter (synthetic fixtures; real execution not subscription-validated)', () => {
  it('uses native resume and permission modes with an isolated private state', async () => {
    const project = directory(),
      stateDirectory = directory(),
      prompt = '$(touch nope); `echo unsafe`\n第二行'
    const input = {
      executable: '/bin/grok',
      project,
      preference: { model: 'grok-4.5', effort: 'low' as const },
      mode: 'plan' as const,
      prompt,
      stateDirectory,
      conversationId: 'fixture-existing',
    }
    const prepared = await prepareGrok(input)
    expect(prepared.argv.slice(-2)).toEqual(['--single', '任务：\n' + prompt])
    expect(prepared.argv).toContain('--resume')
    expect(prepared.argv).not.toContain('--session-id')
    expect(prepared.argv[prepared.argv.indexOf('--permission-mode') + 1]).toBe('default')
    expect(prepared.argv).toContain('read_file,grep,list_dir')
    expect(prepared.argv).not.toContain('bypassPermissions')
    expect(prepared.argv).not.toContain('--sandbox')
    expect(prepared.argv).toContain('--no-subagents')
    expect(prepared.env.GROK_HOME!.startsWith(realpathSync(stateDirectory) + '/')).toBe(true)
    const path = join(prepared.env.GROK_HOME!, 'config.toml')
    expect(statSync(path).mode & 0o077).toBe(0)
    expect(statSync(prepared.env.GROK_HOME!).mode & 0o077).toBe(0)
    expect(readFileSync(path, 'utf8')).toContain('load_envrc = false')
    const editing = await prepareGrok({ ...input, mode: 'accept-edits' })
    expect(editing.env.GROK_HOME).toBe(prepared.env.GROK_HOME)
    expect(editing.argv[editing.argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })
  it('never offers anonymous ACP models as current-account Worker entitlements and rejects invented effort tiers', async () => {
    const models = [{ id: 'grok-4.5', label: 'Grok 4.5', efforts: ['high', 'medium', 'low'] }]
    await expect(
      discoverGrok(
        '/bin/grok',
        async (argv, env) => {
          expect(argv[1]).toMatch(/grok-catalog\.mjs$/)
          expect(argv).not.toContain('--single')
          expect(env?.GROK_TELEMETRY_ENABLED).toBe('0')
          return JSON.stringify(models)
        },
        directory(),
      ),
    ).rejects.toThrow('公共候选')
    await expect(
      discoverGrok(
        '/bin/grok',
        async () => JSON.stringify([{ ...models[0], efforts: ['invented'] }]),
        directory(),
      ),
    ).rejects.toThrow('levels')
  })
  it('performs only initialize IPC and stops the synthetic native catalog process', () => {
    const root = directory(),
      cli = join(root, 'fake-grok.mjs'),
      log = join(root, 'rpc.log')
    writeFileSync(
      cli,
      `#!/usr/bin/env node
import fs from 'node:fs';import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n',{mode:0o600});
if(q.method!=='initialize')process.exit(20);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:1,_meta:{modelState:{availableModels:[{modelId:'grok-fixture',name:'Synthetic Grok',_meta:{supportsReasoningEffort:true,reasoningEfforts:[{id:'high'},{id:'low'}]}}]}}}})+'\\n');});
setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    )
    const output = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../src/host/grok-catalog.mjs', import.meta.url)), cli, root],
      { encoding: 'utf8', timeout: 5000 },
    )
    expect(output.status, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual([
      { id: 'grok-fixture', label: 'Synthetic Grok', efforts: ['high', 'low'] },
    ])
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x).method),
    ).toEqual(['initialize'])
  })
  it('accepts native end_turn only with identity and completed tools', () => {
    const f = fixture()
    f.send(
      {
        type: 'tool_call',
        toolCallId: 'c',
        toolName: 'read_file',
        status: 'in_progress',
        rawInput: { path: 'file' },
      },
      { type: 'tool_call_update', toolCallId: 'c', status: 'completed', rawOutput: { lines: 2 } },
      { type: 'text', data: 'done' },
      f.end,
    )
    expect(f.parser.result).toBeUndefined()
    f.parser.end()
    expect(f.parser.result).toEqual({
      conversationId: 'fixture-session',
      status: 'SUCCESS',
      response: 'done',
    })
    expect(f.events.filter((x) => x.kind === 'tool').map((x) => x.step)).toEqual([1, 1])
    expect(f.ids).toEqual(['fixture-session'])
  })
  it('never promotes an error, denied tool, unfinished tool or stop-limit to success', () => {
    for (const reason of ['max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'EndTurn']) {
      const f = fixture()
      f.send({ ...f.end, stopReason: reason })
      f.parser.end()
      expect(f.parser.result?.status).toBe('ERROR')
    }
    for (const state of ['failed', 'denied', 'in_progress']) {
      const f = fixture()
      f.send({ type: 'tool_call', toolCallId: 'c', toolName: 'bash', status: state }, f.end)
      f.parser.end()
      expect(f.parser.result?.status).toBe('ERROR')
    }
    const f = fixture()
    f.send({ type: 'error', message: 'auth failed' }, f.end)
    f.parser.end()
    expect(f.parser.result?.error).toBe('auth failed')
  })
  it('does not succeed with missing terminal or session identity', () => {
    const f = fixture()
    f.send({ type: 'text', data: 'done' })
    f.parser.end()
    expect(f.parser.result).toBeUndefined()
    expect(() => fixture().send({ type: 'end', stopReason: 'end_turn' })).toThrow('identity')
    const g = fixture()
    g.send({ type: 'text', data: 'done', sessionId: 'fixture' })
    g.parser.end()
    expect(g.parser.result?.status).toBe('ERROR')
  })
  it('rejects session changes, unknown tool updates and events after terminal', () => {
    const f = fixture()
    f.send({ type: 'text', data: 'first', sessionId: 'one' })
    expect(() => f.send({ ...f.end, sessionId: 'two' })).toThrow('identity changed')
    expect(() =>
      fixture().send({ type: 'tool_call_update', toolCallId: 'absent', status: 'completed' }),
    ).toThrow('Unmatched')
    const g = fixture()
    g.send(g.end)
    expect(() => g.send({ type: 'text', data: 'late' })).toThrow('after Grok end')
  })
  it('handles split UTF-8 and omits thought events with bounded frames', () => {
    const f = fixture()
    const bytes = Buffer.from(
      [{ type: 'thought', data: 'private reasoning' }, { type: 'text', data: '中文' }, f.end]
        .map(JSON.stringify)
        .join('\n'),
    )
    for (const b of bytes) f.parser.feed(Buffer.from([b]))
    f.parser.end()
    expect(f.parser.result?.response).toBe('中文')
    expect(JSON.stringify(f.events)).not.toContain('private reasoning')
    expect(() => fixture(20).parser.feed('x'.repeat(21))).toThrow('maxLineBytes')
    expect(() => fixture(20).send({ type: 'text', data: 'x'.repeat(30) })).toThrow('maxLineBytes')
  })
})

it('replaces old worker auth references from the own Grok source and removes them after logout', async () => {
  const native = directory(),
    stateDirectory = directory(),
    project = directory()
  vi.stubEnv('HOME', native)
  mkdirSync(join(native, '.grok'))
  const auth = join(native, '.grok/auth.json')
  writeFileSync(auth, 'SYNTHETIC_OWN_GROK', { mode: 0o600 })
  const input = {
    executable: '/fixture/grok',
    project,
    stateDirectory,
    preference: { model: 'grok-fixture', effort: 'default' as const },
    mode: 'plan' as const,
    prompt: 'synthetic task',
  }
  const first = await prepareGrok(input),
    target = join(first.env.GROK_HOME!, 'auth.json')
  expect(readFileSync(target, 'utf8')).toBe('SYNTHETIC_OWN_GROK')
  rmSync(target)
  writeFileSync(target, 'SYNTHETIC_OLD_WORKER', { mode: 0o600 })
  await prepareGrok({ ...input, conversationId: 'synthetic-session' })
  expect(readFileSync(target, 'utf8')).toBe('SYNTHETIC_OWN_GROK')
  expect(readFileSync(auth, 'utf8')).toBe('SYNTHETIC_OWN_GROK')
  rmSync(auth)
  await prepareGrok({ ...input, conversationId: 'synthetic-session' })
  expect(existsSync(target)).toBe(false)
})
