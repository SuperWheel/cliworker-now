import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, statSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AgyProtocol, type EventInput } from '../src/host/protocol.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { DEFAULT_CONFIG, projectDirectory, agyArguments, type ProcessBackend } from '../src/host/process.ts'
import { foldEvents, type Worker } from '../src/shared/types.ts'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const pref = { model: 'fixture-model', effort: 'high' as const }
const line = (event: object) => JSON.stringify(event) + '\n'
const result = (id = 'conversation', response = 'answer') =>
  line({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response } })
function parser(max = 1024) {
  const events: EventInput[] = []
  const ids: string[] = []
  const protocol = new AgyProtocol(
    (e) => events.push(e),
    (id) => ids.push(id),
    max,
  )
  return { protocol, events, ids }
}
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'cliworker-test-'))
  const project = join(root, 'project')
  mkdirSync(project)
  return { root, project }
}
function makeWorker(project: string): Worker {
  return {
    id: randomUUID(),
    parentSessionId: 'parent',
    project,
    title: 'test',
    preference: pref,
    mode: 'accept-edits',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runId: randomUUID(),
  }
}
class FakeBackend implements ProcessBackend {
  calls: {
    spec: SubprocessSpawnSpec
    stdout: PassThrough
    stderr: PassThrough
    end: (code?: number) => void
    terminated: boolean
  }[] = []
  async resolveExecutable() {
    return '/fixture/agy'
  }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const stdout = new PassThrough(),
      stderr = new PassThrough()
    let settle!: (value: unknown) => void
    const done = new Promise((resolve) => {
      settle = resolve
    })
    const row = {
      spec,
      stdout,
      stderr,
      terminated: false,
      end: (exitCode = 0) => {
        stdout.end()
        stderr.end()
        settle({ exitCode })
      },
    }
    this.calls.push(row)
    const terminate = () => {
      row.terminated = true
      row.end(143)
    }
    spec.signal?.addEventListener('abort', terminate)
    return {
      stdout,
      stderr,
      done,
      terminate,
      waitForExit: async () => {
        await done
        return true
      },
    } as SubprocessHandle
  }
}
function setup(config = {}) {
  const { root, project } = paths()
  const backend = new FakeBackend()
  const storage = new WorkerStorage(join(root, 'state'))
  const runtime = new WorkerRuntime(storage, backend, { ...DEFAULT_CONFIG, ...config })
  cleanups.push(() => runtime.close())
  return { root, project, backend, storage, runtime }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('real protocol format, synthetic fixtures', () => {
  it('handles every-byte UTF-8 splits and folds deltas without duplicate final output', () => {
    const { protocol, events } = parser()
    const raw = Buffer.from(
      line({ event: 'init', conversation_id: 'conversation' }) +
        line({
          event: 'step_update',
          step_update: {
            conversation_id: 'conversation',
            step_index: 2,
            step_type: 'agent_response',
            text_delta: '你好',
          },
        }) +
        result('conversation', '你好'),
    )
    for (const b of raw) protocol.feed(Buffer.from([b]))
    protocol.end()
    expect(protocol.result?.response).toBe('你好')
    const folded = foldEvents(events.map((e, i) => ({ ...e, seq: i + 1, time: '', runId: 'run' })))
    expect(folded.filter((e) => e.kind === 'assistant')).toHaveLength(1)
  })
  it('rejects malformed output', () => expect(() => parser().protocol.feed('not json\n')).toThrow('Invalid'))
  it('rejects excessive complete and partial lines', () => {
    expect(() => parser(3).protocol.feed('abcd')).toThrow('maxLineBytes')
    expect(() => parser(3).protocol.feed('abcd\n')).toThrow('maxLineBytes')
  })
  it('rejects conversation identity changes', () => {
    const { protocol } = parser()
    protocol.feed(line({ event: 'init', conversation_id: 'a' }))
    expect(() => protocol.feed(result('b'))).toThrow('changed')
  })
  it('rejects events following result', () => {
    const { protocol } = parser()
    protocol.feed(result())
    expect(() => protocol.feed(result())).toThrow('after CLI result')
  })
  it('preserves unknown events as diagnostic evidence', () => {
    const { protocol, events } = parser()
    protocol.feed(line({ event: 'future', payload: 'hello' }))
    expect(events[0].detail).toContain('hello')
  })
})
describe('private durable storage', () => {
  it('isolates project preferences and uses private permissions', () => {
    const { storage, project } = setup()
    storage.setPreference(project, pref)
    expect(storage.preference(project)).toEqual(pref)
    expect(storage.preference(project + 'other')).toBeUndefined()
    expect(statSync(storage.directory).mode & 0o777).toBe(0o700)
  })
  it('refuses a second live host and marks unfinished work interrupted on restart', () => {
    const { root, project } = paths()
    const directory = join(root, 'state')
    const first = new WorkerStorage(directory)
    const worker = makeWorker(project)
    first.save(worker)
    expect(() => new WorkerStorage(directory)).toThrow('already owned')
    first.close()
    const restored = new WorkerStorage(directory)
    cleanups.push(() => restored.close())
    expect(restored.workers.get(worker.id)?.status).toBe('interrupted')
    expect(restored.history(worker.id).at(-1)?.state).toBe('interrupted')
    expect(statSync(join(directory, `${worker.id}.worker.json`)).mode & 0o777).toBe(0o600)
    restored.close()
    const reopened = new WorkerStorage(directory)
    cleanups.push(() => reopened.close())
    expect(reopened.history(worker.id)).toHaveLength(1)
  })
  it('recovers only a torn tail and preserves sequence', () => {
    const { root, project } = paths()
    const directory = join(root, 'state')
    const first = new WorkerStorage(directory)
    const worker = makeWorker(project)
    first.save(worker)
    first.append(worker, { kind: 'user', text: 'one' })
    first.close()
    const path = join(directory, `${worker.id}.events.jsonl`)
    appendFileSync(path, '{"broken":')
    const restored = new WorkerStorage(directory)
    cleanups.push(() => restored.close())
    restored.append(worker, { kind: 'assistant', text: 'two' })
    expect(restored.history(worker.id).map((e) => e.seq)).toEqual([1, 2, 3])
    expect(restored.history(worker.id)[1]).toMatchObject({ kind: 'status', state: 'interrupted' })
    expect(readFileSync(path, 'utf8')).not.toContain('broken')
  })
  it('rejects broad workspaces and leaves prompt as a single argv value', () => {
    expect(() => projectDirectory(homedir())).toThrow()
    expect(() => projectDirectory('/')).toThrow()
    const args = agyArguments('/agy', '/project', pref, 'plan', '$(touch bad); /danger', 1000)
    expect(args.at(-1)).toBe('任务：\n$(touch bad); /danger')
    expect(args).not.toContain('--disable-slash-commands')
  })
})
describe('scheduler, cancellation and session continuity', () => {
  it('blocks account changes until that CLI has no active task', async () => {
    const { runtime, backend, project } = setup()
    const task = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    expect(() => runtime.assertAccountIdle('antigravity')).toThrow('还有运行或排队')
    expect(() => runtime.assertAccountIdle('codex')).not.toThrow()
    await tick()
    backend.calls[0].stdout.write(result())
    backend.calls[0].end()
    await task.done
    expect(() => runtime.assertAccountIdle('antigravity')).not.toThrow()
  })
  it('refuses account mutation after an unconfirmed process cleanup even when the worker is failed', async () => {
    const { runtime, backend, project } = setup()
    const spawn = backend.spawn.bind(backend)
    backend.spawn = (spec) => ({ ...spawn(spec), waitForExit: async () => false })
    const task = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    backend.calls[0].stdout.write(result())
    backend.calls[0].end()
    expect((await task.done).status).toBe('failed')
    expect(() => runtime.assertAccountIdle('antigravity')).toThrow('无法确认 CLI 进程已清理')
  })
  it('runs at most two and serializes writers to the same canonical directory', async () => {
    const { runtime, backend, project, root } = setup()
    const other = join(root, 'other')
    mkdirSync(other)
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    const c = runtime.submit('p', other, 'c', 'c', pref, 'accept-edits')
    await tick()
    expect(backend.calls).toHaveLength(2)
    expect(b.worker.status).toBe('queued')
    backend.calls[0].stdout.write(result('a'))
    backend.calls[0].end()
    await a.done
    await tick()
    expect(backend.calls).toHaveLength(3)
    expect(c.worker.status).toBe('running')
    expect(b.worker.status).toBe('running')
  })
  it('blocks concurrent followup, retains model/cwd/conversation and isolates parent access', async () => {
    const { runtime, backend, project } = setup()
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    expect(() => runtime.submit('p', project, 'a', 'b', pref, 'plan', a.worker.id)).toThrow('already')
    expect(() => runtime.get('other', a.worker.id)).toThrow('belong')
    backend.calls[0].stdout.write(result('original'))
    backend.calls[0].end()
    const firstOutcome = await a.done
    const firstRunId = firstOutcome.runId
    const b = runtime.submit(
      'p',
      project,
      'a',
      'follow',
      { model: 'different', effort: 'low' },
      'plan',
      a.worker.id,
    )
    await tick()
    expect(backend.calls[1].spec.cwd).toBe(projectDirectory(project))
    expect(backend.calls[1].spec.argv).toContain('original')
    expect(backend.calls[1].spec.argv).toContain('fixture-model')
    expect(b.worker.mode).toBe('accept-edits')
    expect(firstOutcome).toMatchObject({ status: 'completed', runId: firstRunId, lastResult: 'answer' })
    expect(b.worker.runId).not.toBe(firstRunId)
    backend.calls[1].stdout.write(result('original'))
    backend.calls[1].end()
    await b.done
    expect(runtime.snapshot('p', a.worker.id).timeline.filter((e) => e.kind === 'user')).toHaveLength(2)
  })
  it('stops running processes, and cancels queued tasks before spawn', async () => {
    const { runtime, backend, project } = setup()
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    await tick()
    expect((await runtime.stop('p', b.worker.id)).status).toBe('interrupted')
    expect((await runtime.stop('p', a.worker.id)).status).toBe('interrupted')
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].terminated).toBe(true)
  })
  it.each(['nonzero', 'missing', 'auth', 'mismatch'])('fails honestly for %s output', async (scenario) => {
    const { runtime, backend, project } = setup()
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    const call = backend.calls[0]
    if (scenario === 'nonzero') {
      call.stderr.write('exit failure')
      call.end(2)
    } else if (scenario === 'auth') {
      call.stdout.write(
        line({
          event: 'result',
          result: { conversation_id: 'a', status: 'ERROR', response: 'authentication required' },
        }),
      )
      call.end()
    } else if (scenario === 'mismatch') {
      call.stdout.write(line({ event: 'init', conversation_id: 'a' }) + result('b'))
      call.end()
    } else call.end()
    const outcome = await a.done
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBeTruthy()
    expect(call.terminated).toBe(true)
  })
  it('bounds runaway output and times out idle runs', async () => {
    const { runtime, backend, project } = setup({ maxRunBytes: 10, timeoutMs: 30 })
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    backend.calls[0].stdout.write('x'.repeat(11))
    expect((await a.done).status).toBe('failed')
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    expect((await b.done).status).toBe('interrupted')
  })
})

it('does not repeat earlier streamed steps when final response aggregates them', () => {
  const events = [
    { kind: 'assistant', step: 1, text: 'Working.' },
    { kind: 'tool', step: 2, text: 'run_command' },
    { kind: 'assistant', step: 3, text: 'Done.' },
    { kind: 'result', text: 'Working.\nDone.' },
  ].map((e, i) => ({ ...e, runId: 'r', seq: i + 1, time: '' }))
  const rows = foldEvents(events as import('../src/shared/types.ts').WorkerEvent[])
  expect(rows.filter((e) => e.kind === 'assistant').map((e) => e.text)).toEqual(['Working.', 'Done.'])
})

it('marks unfinished tools at run end without inventing a successful CLI tool result', () => {
  const events = [
    { kind: 'tool', step: 1, text: 'done tool', state: 'DONE' },
    { kind: 'tool', step: 2, text: 'interrupted tool', state: 'ACTIVE' },
    { kind: 'status', text: '用户已停止任务', state: 'interrupted' },
  ].map((e, i) => ({
    ...e,
    seq: i + 1,
    time: '',
    runId: 'first',
  })) as import('../src/shared/types.ts').WorkerEvent[]
  const rows = foldEvents(events)
  expect(rows[0].runStatus).toBeUndefined()
  expect(rows[1]).toMatchObject({ state: 'ACTIVE', runStatus: 'interrupted' })
  expect(events[1]).not.toHaveProperty('runStatus')
  // v0.1.0 stores did not write structured terminal status events.
  expect(foldEvents(events.slice(0, 2), { runId: 'first', status: 'interrupted' })[1].runStatus).toBe(
    'interrupted',
  )
  expect(
    foldEvents(events.slice(0, 2), { runId: 'other', status: 'interrupted' })[1].runStatus,
  ).toBeUndefined()
})

describe('history pages from durable events', () => {
  it('can reach the beginning of a conversation beyond the default 1000-row live limit', () => {
    const { runtime, storage, project } = setup()
    const worker = makeWorker(project)
    worker.status = 'completed'
    storage.save(worker)
    for (let i = 0; i < 1250; i++) storage.append(worker, { kind: 'user', text: `long row ${i}` })
    const live = runtime.snapshot('parent', worker.id)
    expect(live.timeline).toHaveLength(1000)
    expect(live.timeline[0].text).toBe('long row 250')
    const page = runtime.history('parent', worker.id, live.timeline[0].id, 'before')
    const first = runtime.history('parent', worker.id, page.items[0].id, 'before')
    expect([...first.items, ...page.items, ...live.timeline].map((i) => i.text)).toEqual(
      Array.from({ length: 1250 }, (_, i) => `long row ${i}`),
    )
  })
  it('walks beyond the live tail in both directions without overlaps while new rows append', () => {
    const { runtime, storage, project } = setup({ maxTimelineItems: 10 })
    const worker = makeWorker(project)
    worker.status = 'completed'
    storage.save(worker)
    for (let i = 0; i < 450; i++) storage.append(worker, { kind: 'user', text: `row ${i}` })
    const live = runtime.snapshot('parent', worker.id)
    expect(live.truncated).toBe(true)
    expect(live.timeline).toHaveLength(10)
    const page = runtime.history('parent', worker.id, live.timeline[0].id, 'before')
    expect([page.start, page.end, page.items.length]).toEqual([240, 440, 200])
    const older = runtime.history('parent', worker.id, page.items[0].id, 'before')
    expect([older.start, older.end]).toEqual([40, 240])
    storage.append(worker, { kind: 'user', text: 'newly arrived' })
    const newer = runtime.history('parent', worker.id, older.items.at(-1)!.id, 'after')
    expect(newer.items.map((i) => i.id)).toEqual(page.items.map((i) => i.id))
    expect(page.total).toBe(450)
    expect(newer.total).toBe(451)
    const beginning = runtime.history('parent', worker.id, older.items[0].id, 'before')
    expect(beginning.hasOlder).toBe(false)
    expect(beginning.items[0].text).toBe('row 0')
    const tail = runtime.history('parent', worker.id, page.items.at(-1)!.id, 'after')
    expect(tail.hasNewer).toBe(false)
    expect(tail.items.at(-1)?.text).toBe('newly arrived')
    expect(runtime.history('parent', worker.id, beginning.items[0].id, 'before').items).toEqual([])
  })
  it('rejects foreign owners, cursors and invalid direction without exposing records', () => {
    const { runtime, storage, project } = setup()
    const a = makeWorker(project),
      b = makeWorker(project)
    storage.save(a)
    storage.save(b)
    storage.append(a, { kind: 'user', text: 'only a' })
    storage.append(b, { kind: 'user', text: 'only b' })
    const anchor = runtime.snapshot('parent', a.id).timeline[0].id
    expect(() => runtime.history('other-parent', a.id, anchor, 'before')).toThrow('belong')
    expect(() => runtime.history('parent', b.id, anchor, 'before')).toThrow('不可用')
    expect(() => runtime.history('parent', a.id, anchor, 'sideways')).toThrow('direction')
    expect(() => runtime.history('parent', a.id, '', 'before')).toThrow('有效')
  })
})

it('mixed CLI writers share the directory lock and followup retains its original adapter', async () => {
  const { runtime, backend, project } = setup()
  const codex = runtime.submit(
    'parent',
    project,
    'Codex',
    'one',
    { cli: 'codex', model: 'c', effort: 'low' },
    'accept-edits',
  )
  const claude = runtime.submit(
    'parent',
    project,
    'Claude',
    'two',
    { cli: 'claude', model: 's', effort: 'high' },
    'accept-edits',
  )
  await tick()
  expect(backend.calls).toHaveLength(1)
  backend.calls[0].stdout.write(
    line({ type: 'thread.started', thread_id: 'codex-id' }) +
      line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'one' } }) +
      line({ type: 'turn.completed' }),
  )
  backend.calls[0].end()
  await codex.done
  await tick()
  expect(backend.calls).toHaveLength(2)
  backend.calls[1].stdout.write(
    line({ type: 'system', subtype: 'init', session_id: 'claude-id', model: 'actual-model' }) +
      line({ type: 'result', subtype: 'success', session_id: 'claude-id', result: 'two' }),
  )
  backend.calls[1].end()
  expect((await claude.done).observedModel).toBe('actual-model')
  const resumed = runtime.submit(
    'parent',
    project,
    'Codex',
    'again',
    { cli: 'claude', model: 'wrong', effort: 'high' },
    'accept-edits',
    codex.worker.id,
  )
  await tick()
  expect(backend.calls[2].spec.argv).toContain('resume')
  expect(backend.calls[2].spec.argv).toContain('codex-id')
  expect(backend.calls[2].spec.argv).not.toContain('wrong')
  await runtime.stop('parent', resumed.worker.id)
  expect((await resumed.done).status).toBe('interrupted')
  expect(backend.calls[2].terminated).toBe(true)
})

it('idle worker model changes preserve the conversation and cannot race a queued turn', async () => {
  const { runtime, backend, project } = setup()
  const first = runtime.submit('parent', project, 'one', 'hello', pref, 'plan')
  await tick()
  backend.calls[0]!.stdout.write(result('retained-id'))
  backend.calls[0]!.end()
  await first.done
  runtime.configureWorker('parent', first.worker.id, { model: 'next-model', effort: 'low' })
  expect(runtime.get('parent', first.worker.id).conversationId).toBe('retained-id')
  expect(() => runtime.configureWorker('other', first.worker.id, pref)).toThrow()
  expect(() => runtime.configureWorker('parent', first.worker.id, { cli: 'codex', ...pref })).toThrow()
  const second = runtime.submit('parent', project, 'one', 'followup', pref, 'plan', first.worker.id)
  expect(() => runtime.configureWorker('parent', first.worker.id, pref)).toThrow('本轮结束')
  await tick()
  expect(backend.calls[1]!.spec.argv).toContain('next-model')
  expect(backend.calls[1]!.spec.argv).toContain('retained-id')
  backend.calls[1]!.stdout.write(result('retained-id'))
  backend.calls[1]!.end()
  await second.done
})

it('run timing uses persisted per-turn events and survives a sliced timeline', () => {
  const rows = foldEvents([
    { seq: 1, runId: 'first', time: '2026-10-04T00:00:00Z', kind: 'user', text: 'one' },
    { seq: 2, runId: 'first', time: '2026-10-04T00:00:03Z', kind: 'assistant', text: 'answer' },
    { seq: 3, runId: 'first', time: '2026-10-04T00:00:04Z', kind: 'status', text: 'completed' },
    { seq: 4, runId: 'second', time: '2026-10-04T01:00:00Z', kind: 'user', text: 'two' },
  ])
  expect(rows[1]).toMatchObject({
    runStartedAt: '2026-10-04T00:00:00Z',
    runEndedAt: '2026-10-04T00:00:04Z',
    runOutcome: 'completed',
  })
  expect(rows[3]?.runEndedAt).toBeUndefined()
})

// Synthetic authorization fixture for lifecycle/protocol tests; own-account rules
// are exercised separately by authorized-catalog and runtime-account-isolation.
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async () => 'synthetic-own-account',
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: '账号已变更，请重新选择或新建任务',
  authorizeSelection: async (preference: unknown) => ({ binding: 'synthetic-own-account', preference }),
}))
