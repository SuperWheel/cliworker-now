import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { CliWorkerService } from '../src/host/index.ts'
import { WorkerStorage, type DispatchSetup } from '../src/host/storage.ts'
import { validatePreference, type Catalog } from '../src/host/adapters.ts'
import { resolveModel } from '../src/shared/models.ts'
import type { CliId } from '../src/shared/types.ts'
import { NO_ROLE_LABEL, roleSnapshot } from '../src/host/roles.ts'

// Actual Host selection and private storage, with explicit synthetic catalogs and accounts.
// No executable, credential, native login or model request is used by these fixtures.
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-dispatch-flow-')))
  const storage = new WorkerStorage(join(project, 'state'))
  cleanups.push(
    () => rmSync(project, { recursive: true, force: true }),
    () => storage.close(),
  )
  const requests: Array<{ request: any; resolve: (value: AskUserQuestionAnswer) => void }> = []
  const ask = vi.fn(
    (request: any) => new Promise<AskUserQuestionAnswer>((resolve) => requests.push({ request, resolve })),
  )
  let binding = 'synthetic-account-a',
    enabled = true
  let models: Catalog['models'] = [
    { id: 'fixture-a', label: 'Fixture A', efforts: ['low', 'high'] },
    { id: 'fixture-b', label: 'Fixture B', efforts: ['default'] },
  ]
  const service: any = Object.create(CliWorkerService.prototype)
  Object.assign(service, {
    disposed: new AbortController(),
    pending: new Map(),
    dispatchWaits: new Map(),
    selectionBindings: new WeakMap(),
    runtime: {
      storage,
      changed: vi.fn(),
      assertCliEnabled: () => {
        if (!enabled) throw new Error('CLI 已关闭')
      },
    },
    assertExecution: vi.fn(),
    queryCatalog: vi.fn(async (cli: CliId) => ({
      catalog: { cli, models, notice: 'Synthetic catalog notice should not enter cards' },
      binding,
    })),
    querySelection: vi.fn(
      async (
        preference: any,
        _backend: any,
        _options: any,
        _project: any,
        signal: AbortSignal,
        expected: string,
      ) => {
        signal.throwIfAborted()
        if (expected !== binding) throw new Error('账号已变更')
        const catalog = { cli: preference.cli, models, notice: 'Synthetic' }
        validatePreference(preference, catalog)
        return { catalog, binding, preference: resolveModel(preference, models) }
      },
    ),
  })
  const agents = new Map<string, any>()
  const agent = (id = 'parent', cwd = project) => {
    if (!agents.has(id))
      agents.set(id, {
        id,
        session: { header: { cwd, origin: 'user' } },
        ctx: { get: (name: string) => (name === 'userQuestions' ? { ask } : undefined) },
      })
    return agents.get(id)
  }
  const choose = (
    id = 'parent',
    cli: CliId = 'antigravity',
    signal = new AbortController().signal,
    cwd = project,
  ) => service.chooseDispatch(agent(id, cwd), signal, cli) as Promise<DispatchSetup>
  const respond = (index: number, answers: Record<string, string>) =>
    requests[index]!.resolve({
      answers: Object.entries(answers).map(([id, value]) => ({ id, selected: [value] })),
    })
  const ready = async (n: number) => vi.waitFor(() => expect(requests).toHaveLength(n))
  const complete = async (offset = 0, model = 'Fixture A', role = NO_ROLE_LABEL) => {
    await ready(offset + 1)
    respond(offset, { cliworker_model: model })
    await ready(offset + 2)
    respond(offset + 1, {
      ...(model === 'Fixture A' ? { cliworker_effort: 'high' } : {}),
      cliworker_role: role,
    })
  }
  const setup: DispatchSetup = {
    preference: { cli: 'antigravity', model: 'fixture-a', effort: 'low' },
    role: null,
    binding,
  }
  return {
    project,
    storage,
    service,
    requests,
    ask,
    agent,
    choose,
    respond,
    ready,
    complete,
    setup,
    setBinding: (value: string) => {
      binding = value
    },
    disable: () => {
      enabled = false
    },
    setModels: (value: typeof models) => {
      models = value
    },
  }
}

it('first use asks model then only its actual efforts with role, with no detail or option descriptions', async () => {
  const f = fixture(),
    pending = f.choose()
  await f.complete()
  const result = await pending
  expect(result.preference).toEqual({ cli: 'antigravity', model: 'fixture-a', effort: 'high' })
  expect(result.role).toBeNull()
  expect(f.requests[1]!.request.questions.map((x: any) => x.id)).toEqual([
    'cliworker_effort',
    'cliworker_role',
  ])
  expect(f.requests[1]!.request.questions[0].options).toEqual([{ label: 'low' }, { label: 'high' }])
  for (const { request } of f.requests)
    for (const question of request.questions) {
      expect(question).not.toHaveProperty('detail')
      for (const option of question.options) expect(option).not.toHaveProperty('description')
    }
  expect(f.storage.dispatchSetup(f.project, 'antigravity')).toEqual(result)
  expect(f.storage.conversationSetup('parent', f.project, 'antigravity')).toEqual(result)
  expect(f.service.pending.size).toBe(0)
})

it('one supported effort asks only role and a legacy preference never substitutes for complete setup', async () => {
  const f = fixture()
  f.storage.setPreference(f.project, f.setup.preference)
  const pending = f.choose()
  await f.complete(0, 'Fixture B')
  const result = await pending
  expect(f.requests[0]!.request.questions[0].id).toBe('cliworker_model')
  expect(f.requests[1]!.request.questions.map((x: any) => x.id)).toEqual(['cliworker_role'])
  expect(result.preference.effort).toBe('default')
})

it('same conversation reuses its frozen setup even if project default or role library changes', async () => {
  const f = fixture()
  const role = roleSnapshot(f.storage.rolePresets()[0]!)
  f.storage.setConversationSetup('parent', f.project, { ...f.setup, role })
  f.storage.setDispatchSetup(f.project, {
    ...f.setup,
    preference: { cli: 'antigravity', model: 'fixture-b', effort: 'default' },
  })
  f.storage.deleteRolePreset(role.presetId!)
  expect(await f.choose()).toEqual({ ...f.setup, role })
  expect(await f.choose()).toEqual({ ...f.setup, role })
  expect(f.ask).not.toHaveBeenCalled()
  expect(f.service.querySelection).toHaveBeenCalledTimes(2)
})

it('new conversation asks only reuse and captures the offered default without overwriting newer project defaults', async () => {
  const f = fixture()
  f.storage.setDispatchSetup(f.project, f.setup)
  const pending = f.choose('new')
  await f.ready(1)
  expect(f.requests[0]!.request.questions[0]).toMatchObject({
    id: 'cliworker_reuse',
    options: [{ label: '沿用' }, { label: '重新选择' }],
  })
  const newer = {
    ...f.setup,
    preference: { cli: 'antigravity' as const, model: 'fixture-b', effort: 'default' as const },
  }
  f.storage.setDispatchSetup(f.project, newer)
  f.respond(0, { cliworker_reuse: '沿用' })
  expect(await pending).toEqual(f.setup)
  expect(f.storage.dispatchSetup(f.project, 'antigravity')).toEqual(newer)
  expect(f.ask).toHaveBeenCalledTimes(1)
})

it('declining reuse selects and replaces the complete setup for project and only this conversation', async () => {
  const f = fixture()
  f.storage.setDispatchSetup(f.project, f.setup)
  f.storage.setConversationSetup('old', f.project, f.setup)
  const pending = f.choose('new')
  await f.ready(1)
  f.respond(0, { cliworker_reuse: '重新选择' })
  await f.complete(1, 'Fixture B')
  const selected = await pending
  expect(selected.preference.model).toBe('fixture-b')
  expect(f.storage.dispatchSetup(f.project, 'antigravity')).toEqual(selected)
  expect(f.storage.conversationSetup('old', f.project, 'antigravity')).toEqual(f.setup)
})

it('projects and CLIs do not borrow another scope confirmation', async () => {
  const f = fixture()
  f.storage.setConversationSetup('parent', f.project, f.setup)
  f.storage.setDispatchSetup(f.project, f.setup)
  const other = join(f.project, 'another')
  mkdirSync(other)
  const first = f.choose('parent', 'codex')
  await f.complete(0, 'Fixture B')
  expect((await first).preference.cli).toBe('codex')
  const second = f.choose('other', 'antigravity', undefined, other)
  await f.complete(2, 'Fixture B')
  await second
  expect(f.storage.conversationSetup('other', other, 'antigravity')).toBeDefined()
})

it.each(['account', 'model', 'effort'] as const)(
  'invalid %s confirmation starts full selection instead of silently changing the route',
  async (invalid) => {
    const f = fixture()
    f.storage.setConversationSetup('parent', f.project, f.setup)
    f.storage.setDispatchSetup(f.project, f.setup)
    if (invalid === 'account') f.setBinding('synthetic-account-b')
    else if (invalid === 'model') f.setModels([{ id: 'fixture-b', label: 'Fixture B', efforts: ['default'] }])
    else
      f.setModels([
        { id: 'fixture-a', label: 'Fixture A', efforts: ['high'] },
        { id: 'fixture-b', label: 'Fixture B', efforts: ['default'] },
      ])
    const pending = f.choose()
    await f.complete(0, 'Fixture B')
    await pending
    expect(f.requests[0]!.request.questions[0].id).toBe('cliworker_model')
  },
)

it('account change during questions rejects without writing partial defaults or confirmation', async () => {
  const f = fixture(),
    pending = f.choose()
  const rejected = expect(pending).rejects.toThrow('账号已变更')
  await f.ready(1)
  f.respond(0, { cliworker_model: 'Fixture A' })
  await f.ready(2)
  f.setBinding('synthetic-account-b')
  f.respond(1, { cliworker_effort: 'high', cliworker_role: NO_ROLE_LABEL })
  await rejected
  expect(f.storage.preference(f.project)).toBeUndefined()
  expect(f.storage.conversationSetup('parent', f.project, 'antigravity')).toBeUndefined()
})

it('same conversation concurrency asks one set; followers freshly validate the saved result', async () => {
  const f = fixture(),
    one = f.choose(),
    two = f.choose()
  await f.complete()
  expect(await one).toEqual(await two)
  expect(f.ask).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => expect(f.service.dispatchWaits.size).toBe(0))
  expect(f.service.queryCatalog).toHaveBeenCalledTimes(2)
})

it('different conversations cannot consume another conversation pending answers', async () => {
  const f = fixture(),
    one = f.choose('one'),
    two = f.choose('two')
  await f.ready(2)
  expect(f.requests.map((x) => x.request.agent.id).sort()).toEqual(['one', 'two'])
  f.respond(0, { cliworker_model: 'Fixture B' })
  f.respond(1, { cliworker_model: 'Fixture B' })
  await f.ready(4)
  f.respond(2, { cliworker_role: NO_ROLE_LABEL })
  f.respond(3, { cliworker_role: NO_ROLE_LABEL })
  await Promise.all([one, two])
  expect(f.ask).toHaveBeenCalledTimes(4)
})

it('waiting cancellation is prompt, cannot release the leader slot, and a later waiter still shares its result', async () => {
  const f = fixture(),
    one = f.choose()
  await f.ready(1)
  const abort = new AbortController(),
    two = f.choose('parent', 'antigravity', abort.signal)
  const rejected = expect(two).rejects.toThrow('waiter cancelled')
  abort.abort(new Error('waiter cancelled'))
  await rejected
  const three = f.choose()
  await Promise.resolve()
  expect(f.ask).toHaveBeenCalledTimes(1)
  await f.complete()
  expect(await one).toEqual(await three)
  await vi.waitFor(() => expect(f.service.dispatchWaits.size).toBe(0))
})

it('leader cancellation leaves no partial setup, releases followers, and ignores its late answer', async () => {
  const f = fixture(),
    abort = new AbortController(),
    one = f.choose('parent', 'antigravity', abort.signal)
  const rejected = expect(one).rejects.toThrow('leader cancelled')
  await f.ready(1)
  const two = f.choose()
  abort.abort(new Error('leader cancelled'))
  await rejected
  await f.ready(2)
  f.respond(0, { cliworker_model: 'Fixture A' })
  expect(f.storage.preference(f.project)).toBeUndefined()
  await f.complete(1, 'Fixture B')
  expect((await two).preference.model).toBe('fixture-b')
  expect(f.ask).toHaveBeenCalledTimes(3)
})

it('role cancellation and missing role never save the already selected model', async () => {
  for (const cancel of [true, false]) {
    const f = fixture(),
      abort = new AbortController(),
      pending = f.choose('parent', 'antigravity', abort.signal)
    const rejected = expect(pending).rejects.toThrow(cancel ? 'role cancelled' : '请选择角色')
    await f.ready(1)
    f.respond(0, { cliworker_model: 'Fixture A' })
    await f.ready(2)
    if (cancel) abort.abort(new Error('role cancelled'))
    else f.respond(1, { cliworker_effort: 'high' })
    await rejected
    expect(f.storage.preference(f.project)).toBeUndefined()
    expect(f.storage.dispatchSetup(f.project, 'antigravity')).toBeUndefined()
  }
})

it('plugin disposal cancels questions and waiting callers and clears admission/pending state', async () => {
  const f = fixture(),
    one = f.choose(),
    two = f.choose()
  const failures = Promise.all([
    expect(one).rejects.toThrow('disposed'),
    expect(two).rejects.toThrow('disposed'),
  ])
  await f.ready(1)
  f.service.disposed.abort(new Error('disposed'))
  await failures
  await vi.waitFor(() => expect(f.service.dispatchWaits.size).toBe(0))
  expect(f.service.pending.size).toBe(0)
  expect(f.storage.preference(f.project)).toBeUndefined()
})

it('offered role snapshot remains stable through library edits and final project/CLI changes fail closed', async () => {
  const f = fixture(),
    preset = f.storage.rolePresets()[0]!,
    pending = f.choose()
  await f.ready(1)
  f.respond(0, { cliworker_model: 'Fixture B' })
  await f.ready(2)
  f.storage.saveRolePreset({ ...preset, prompt: 'Synthetic changed later' })
  f.respond(1, { cliworker_role: preset.name })
  expect((await pending).role?.prompt).toBe(preset.prompt)
  const second = fixture(),
    attempt = second.choose(),
    rejected = expect(attempt).rejects.toThrow('CLI 已关闭')
  await second.ready(1)
  second.respond(0, { cliworker_model: 'Fixture B' })
  await second.ready(2)
  second.disable()
  second.respond(1, { cliworker_role: NO_ROLE_LABEL })
  await rejected
  expect(second.storage.preference(second.project)).toBeUndefined()
})

it('current project change at final authorization never persists the old project selection', async () => {
  const f = fixture(),
    pending = f.choose()
  const rejected = expect(pending).rejects.toThrow('项目已变更')
  await f.ready(1)
  f.respond(0, { cliworker_model: 'Fixture B' })
  await f.ready(2)
  f.agent().session.header.cwd = join(f.project, 'state')
  f.respond(1, { cliworker_role: NO_ROLE_LABEL })
  await rejected
  expect(f.storage.preference(f.project)).toBeUndefined()
})

it('unknown/custom model and reuse answers never select an option on behalf of the user', async () => {
  const f = fixture(),
    pending = f.choose()
  const rejected = expect(pending).rejects.toThrow('请选择列表中的模型')
  await f.ready(1)
  f.requests[0]!.resolve({
    answers: [{ id: 'cliworker_model', selected: ['Fixture A'], custom: 'anything' }],
  })
  await rejected
  expect(f.storage.preference(f.project)).toBeUndefined()
  f.storage.setDispatchSetup(f.project, f.setup)
  const retry = f.choose(),
    invalid = expect(retry).rejects.toThrow('请选择沿用或重新选择')
  await f.ready(2)
  f.respond(1, { cliworker_reuse: 'not an option' })
  await invalid
  expect(f.storage.conversationSetup('parent', f.project, 'antigravity')).toBeUndefined()
})

it('failure to persist confirmation returns an error and never leaves partially selected fields', async () => {
  const f = fixture()
  vi.spyOn(f.storage, 'setConversationSetup').mockImplementation(() => {
    throw new Error('synthetic disk failure')
  })
  const pending = f.choose(),
    rejected = expect(pending).rejects.toThrow('synthetic disk failure')
  await f.complete()
  await rejected
  expect(f.storage.dispatchSetup(f.project, 'antigravity')).toEqual({
    preference: { cli: 'antigravity', model: 'fixture-a', effort: 'high' },
    role: null,
    binding: 'synthetic-account-a',
  })
  expect(f.storage.conversationSetup('parent', f.project, 'antigravity')).toBeUndefined()
})

it('reopened Host storage reuses this conversation without any question', async () => {
  const f = fixture()
  f.storage.setConversationSetup('parent', f.project, f.setup)
  f.storage.close()
  const reopened = new WorkerStorage(join(f.project, 'state'))
  cleanups.push(() => reopened.close())
  f.service.runtime.storage = reopened
  f.service.dispatchWaits = new Map()
  f.service.selectionBindings = new WeakMap()
  expect(await f.choose()).toEqual(f.setup)
  expect(f.ask).not.toHaveBeenCalled()
  expect(f.service.querySelection).toHaveBeenCalledOnce()
})

it('replays omitted CLI then explicit Hermes without consuming the previous Antigravity setup', async () => {
  const f = fixture()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const launch = vi.fn(async (_agent, _title, _prompt, preference) => JSON.stringify(preference))
  Object.assign(f.service, { ctx, launch })
  f.service.registerTools()
  const agy = structuredClone(f.setup)
  const hermes: DispatchSetup = {
    preference: { cli: 'hermes', model: 'fixture-b', effort: 'default' },
    role: null,
    binding: f.setup.binding,
  }
  f.storage.setDispatchSetup(f.project, agy)
  f.storage.setConversationSetup('parent', f.project, agy)
  f.storage.setDispatchSetup(f.project, hermes)
  const start = ctx.tools.get('cliworker_start')!
  const exec = { agent: f.agent(), signal: new AbortController().signal } as any
  const request = { title: '说一句你好', prompt: '请只回复一句话：你好。' }
  try {
    await expect(start.execute(request, exec)).rejects.toThrow(/cli/)
    expect(f.service.queryCatalog).not.toHaveBeenCalled()
    expect(f.ask).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    const pending = start.execute({ ...request, cli: 'hermes' }, exec)
    await f.ready(1)
    expect(f.requests[0]!.request.questions).toMatchObject([
      { id: 'cliworker_reuse', question: '是否沿用 Fixture B · default · 不使用角色预设？' },
    ])
    expect(f.service.queryCatalog.mock.calls.map((args: any[]) => args[0])).toEqual(['hermes'])
    expect(launch).not.toHaveBeenCalled()
    f.respond(0, { cliworker_reuse: '沿用' })
    expect(JSON.parse((await pending) as string)).toEqual(hermes.preference)
    expect(f.storage.conversationSetup('parent', f.project, 'hermes')).toEqual(hermes)
    expect(f.storage.conversationSetup('parent', f.project, 'antigravity')).toEqual(agy)
    expect(f.storage.dispatchSetup(f.project, 'antigravity')).toEqual(agy)
    expect(f.service.querySelection.mock.calls[0][0]).toEqual(hermes.preference)
    expect(launch).toHaveBeenCalledOnce()
  } finally {
    await ctx.fiber.dispose()
  }
})
