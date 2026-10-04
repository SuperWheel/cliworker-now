import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CliProtocol } from '../src/host/cli-protocol.ts'
import { workerArguments, validatePreference } from '../src/host/adapters.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { cliOf, foldEvents, type CliId, type Worker, type WorkerEvent } from '../src/shared/types.ts'
function harness(cli: 'codex' | 'claude' | 'kimi') {
  const events: WorkerEvent[] = [],
    ids: string[] = []
  const parser = new CliProtocol(
    cli,
    (e) => events.push({ ...e, seq: events.length + 1, time: '', runId: 'run' }),
    (id) => ids.push(id),
    8192,
  )
  const send = (...items: unknown[]) => parser.feed(items.map((v) => JSON.stringify(v)).join('\n') + '\n')
  return { parser, events, ids, send }
}
describe('CLI public protocols (synthetic fixtures)', () => {
  it('Codex preserves tool updates and consumes final answer once', () => {
    const { parser, events, send } = harness('codex')
    send(
      { type: 'thread.started', thread_id: 'thread' },
      { type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'pwd' } },
      {
        type: 'item.completed',
        item: {
          id: 'cmd',
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '/project',
          exit_code: 0,
        },
      },
      { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: '完成' } },
      { type: 'turn.completed', usage: {} },
    )
    parser.end()
    expect(parser.result).toMatchObject({ status: 'SUCCESS', response: '完成', conversationId: 'thread' })
    expect(foldEvents(events).filter((e) => e.kind === 'assistant')).toHaveLength(1)
    expect(foldEvents(events).find((e) => e.kind === 'tool')).toMatchObject({ state: 'COMPLETED' })
  })
  it('Claude deduplicates assistant envelopes and reports permission denial', () => {
    const { parser, send, events } = harness('claude')
    const message = {
      type: 'assistant',
      session_id: 's',
      message: {
        id: 'm',
        content: [
          { type: 'text', text: '检查中' },
          { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
    }
    send(
      { type: 'system', subtype: 'init', session_id: 's' },
      message,
      message,
      {
        type: 'user',
        session_id: 's',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'denied', is_error: true }] },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        result: '需要批准',
        permission_denials: [{ tool_name: 'Bash' }],
      },
    )
    expect(parser.result?.status).toBe('ERROR')
    expect(foldEvents(events).filter((e) => e.kind === 'assistant')).toHaveLength(1)
    expect(foldEvents(events).find((e) => e.kind === 'tool')?.state).toBe('FAILED')
  })
  it('Kimi pairs tool results and requires a resume receipt before completion', () => {
    const { parser, send, events } = harness('kimi')
    send(
      {
        role: 'assistant',
        tool_calls: [{ id: 'tool', function: { name: 'Read', arguments: '{"path":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'tool', content: 'file content' },
      { role: 'assistant', content: '最终回复' },
      { role: 'meta', type: 'session.resume_hint', session_id: 'kimi-session' },
    )
    expect(parser.result).toBeUndefined()
    parser.end()
    expect(parser.result).toMatchObject({
      status: 'SUCCESS',
      conversationId: 'kimi-session',
      response: '最终回复',
    })
    expect(foldEvents(events).find((e) => e.kind === 'tool')).toMatchObject({
      text: 'Read',
      state: 'COMPLETED',
      detail: 'file content',
    })
  })
  it('does not infer Kimi session IDs from the newest external session', () => {
    const { parser, send } = harness('kimi')
    send({ role: 'assistant', content: 'reply' })
    parser.end()
    expect(parser.result).toBeUndefined()
  })
  it.each(['codex', 'claude', 'kimi'] as const)(
    '%s rejects malformed and oversized JSONL, including incomplete final lines',
    (cli) => {
      const { parser } = harness(cli)
      parser.feed('{')
      expect(() => parser.end()).toThrow()
      expect(() => harness(cli).parser.feed('x'.repeat(9000))).toThrow('maxLineBytes')
    },
  )
  it('keeps UTF8 chunks intact and rejects a switched resume identity', () => {
    const { parser } = harness('codex')
    const bytes = Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: '会话' }) + '\n')
    for (const byte of bytes) parser.feed(Buffer.from([byte]))
    expect(parser.conversationId).toBe('会话')
    expect(() => parser.feed('{"type":"thread.started","thread_id":"other"}\n')).toThrow('ID changed')
  })
  it('Codex failure cannot become success at EOF', () => {
    const { parser, send } = harness('codex')
    send({ type: 'thread.started', thread_id: 'id' }, { type: 'turn.failed', error: { message: 'auth' } })
    parser.end()
    expect(parser.result?.status).toBe('ERROR')
    expect(() => send({ type: 'turn.completed' })).toThrow()
  })
})
describe('CLI launch and preference boundaries', () => {
  it.each(['codex', 'claude', 'kimi'] as const)(
    '%s pins the exact session and model using argument arrays',
    (cli) => {
      const argv = workerArguments(
        cli,
        '/project',
        { cli, model: 'model', effort: cli === 'kimi' ? 'default' : 'low' },
        'accept-edits',
        '$(touch dangerous);`echo x`',
        1000,
        'exact-id',
      )
      expect(argv).toContain('exact-id')
      expect(argv).toContain('model')
      expect(argv.at(-1)).toBe('任务：\n$(touch dangerous);`echo x`')
      expect(argv.join(' ')).not.toMatch(/bypassPermissions|dangerously-bypass|--yolo|--auto/)
    },
  )
  it('refuses unsupported Kimi read-only and effort flags', () => {
    expect(() =>
      workerArguments('kimi', '/p', { cli: 'kimi', model: 'm', effort: 'default' }, 'plan', 'x', 1),
    ).toThrow('只读')
    expect(() =>
      workerArguments('kimi', '/p', { cli: 'kimi', model: 'm', effort: 'high' }, 'accept-edits', 'x', 1),
    ).toThrow('强度')
    expect(() =>
      validatePreference(
        { cli: 'claude', model: 'm', effort: 'high' },
        { cli: 'codex', models: [], notice: '' },
      ),
    ).toThrow()
  })
  it('separates project+CLI defaults and reads legacy Antigravity workers after restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-multi-'))
    let store = new WorkerStorage(root)
    try {
      for (const cli of ['antigravity', 'codex', 'claude', 'kimi'] as CliId[])
        store.setPreference('/project', { cli, model: cli, effort: 'low' })
      expect(store.preference('/project', 'codex')?.model).toBe('codex')
      expect(store.preference('/project', 'kimi')?.model).toBe('kimi')
      expect(store.preference('/other', 'codex')).toBeUndefined()
      const worker: Worker = {
        id: randomUUID(),
        parentSessionId: 'parent',
        project: '/project',
        title: 'legacy',
        preference: { model: 'agy-model', effort: 'low' },
        mode: 'plan',
        status: 'completed',
        createdAt: '',
        updatedAt: '',
        runId: randomUUID(),
      }
      store.save(worker)
      store.close()
      store = new WorkerStorage(root)
      expect(cliOf(store.workers.get(worker.id)!.preference)).toBe('antigravity')
      expect(store.preference('/project')?.model).toBe('antigravity')
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

it('MiMo requires a stop step and clean EOF, ignoring hidden reasoning', () => {
  const rows: WorkerEvent[] = []
  const parser = new CliProtocol(
    'mimo',
    (e) => rows.push({ ...e, seq: rows.length + 1, runId: 'run', time: '' }),
    () => {},
    8192,
  )
  for (const event of [
    { type: 'step_start', sessionID: 'ses_1', part: {} },
    { type: 'reasoning', sessionID: 'ses_1', part: { text: 'not displayed' } },
    {
      type: 'tool_use',
      sessionID: 'ses_1',
      part: { id: 'tool', tool: 'read', state: { status: 'completed', output: 'x' } },
    },
    { type: 'text', sessionID: 'ses_1', part: { id: 'text', text: 'done' } },
    { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop' } },
  ])
    parser.feed(JSON.stringify(event) + '\n')
  expect(parser.result).toBeUndefined()
  parser.end()
  expect(parser.result).toMatchObject({ conversationId: 'ses_1', status: 'SUCCESS', response: 'done' })
  expect(JSON.stringify(rows)).not.toContain('not displayed')
  const args = workerArguments(
    'mimo',
    '/project',
    { cli: 'mimo', model: 'p/m', effort: 'high' },
    'plan',
    'task',
    1,
    'ses_1',
  )
  expect(args).toEqual([
    'mimo',
    'run',
    '--format',
    'json',
    '--model',
    'p/m',
    '--agent',
    'plan',
    '--variant',
    'high',
    '--session',
    'ses_1',
    '任务：\ntask',
  ])
})
it('MiMo models catalog uses only declared variants', async () => {
  const { parseMimoModels } = await import('../src/host/adapters.ts')
  expect(
    parseMimoModels(
      'provider/model — window 128K\n{\n"name": "Example",\n"variants":{"high":{},"low":{},"unknown":{}}\n}\n',
    ),
  ).toEqual([{ id: 'provider/model', label: 'Example', efforts: ['default', 'high', 'low'] }])
})
it('Claude reports alias resolution separately from the chosen model', () => {
  const { send, events } = harness('claude')
  send({ type: 'system', subtype: 'init', session_id: 's', model: 'resolved-model' })
  expect(events[0]?.observedModel).toBe('resolved-model')
})

it('Kimi tool-only EOF is not mistaken for a completed answer', () => {
  const { parser, send } = harness('kimi')
  send(
    {
      role: 'assistant',
      content: 'I will read',
      tool_calls: [{ id: 't', function: { name: 'Read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 't', content: 'x' },
    { role: 'meta', type: 'session.resume_hint', session_id: 's' },
  )
  parser.end()
  expect(parser.result).toBeUndefined()
})
