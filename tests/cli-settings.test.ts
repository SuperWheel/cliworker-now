import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CLI_IDS, type Worker } from '../src/shared/types.ts'
import { CliWorkerService } from '../src/host/index.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import { catalogFor, type Catalog } from '../src/host/adapters.ts'

vi.mock('../src/host/adapters.ts', async (original) => ({
  ...(await original<object>()),
  catalogFor: vi.fn(),
}))

// Synthetic storage, parent context and subprocesses; no real CLI/account is changed.
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})
const preference = { cli: 'antigravity' as const, model: 'fixture', effort: 'low' as const }
const catalog: Catalog = {
  cli: 'antigravity',
  models: [{ id: 'fixture', label: 'Synthetic fixture', efforts: ['low'] }],
  notice: 'Synthetic fixture',
}
it('a settings model-query cleanup failure blocks later metadata and task admission', async () => {
  const f = fixture()
  vi.mocked(catalogFor).mockRejectedValueOnce(new ProcessCleanupUnconfirmedError())
  await expect(
    f.service.catalogForCli('parent', 'antigravity', new AbortController().signal),
  ).rejects.toThrow()
  await expect(
    f.service.catalogForCli('parent', 'antigravity', new AbortController().signal),
  ).rejects.toThrow('清理')
  expect(() =>
    f.runtime.submit('parent', f.project, 'Synthetic', 'Synthetic', preference, 'accept-edits'),
  ).toThrow('清理')
  expect(catalogFor).toHaveBeenCalledTimes(1)
  expect(f.backend.spawn).not.toHaveBeenCalled()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => (resolve = yes))
  return { promise, resolve }
}
function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-enabled-test-')))
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const storage = new WorkerStorage(join(project, 'state'))
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => '/synthetic/agy'),
    spawn: vi.fn(() => {
      throw new Error('No CLI process should be started by this fixture')
    }),
  }
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  const accounts = { isBusy: vi.fn(() => false), start: vi.fn(), status: vi.fn() }
  const ask = vi.fn()
  const jobs = { start: vi.fn() }
  const agent = {
    id: 'parent',
    session: { header: { cwd: project, origin: 'user' } },
    ctx: {
      get: (name: string) =>
        ({
          userQuestions: { ask },
          jobs,
          sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
        })[name],
    },
  }
  const tools = new Map<string, any>()
  const service = Object.create(CliWorkerService.prototype) as CliWorkerService
  Object.defineProperties(service, {
    ctx: {
      value: {
        subprocess: backend,
        tools: { register: (tool: any) => tools.set(tool.name, tool) },
        effect: (setup: () => unknown) => setup(),
      },
    },
    parent: { value: vi.fn(async () => agent) },
    runtime: { value: runtime },
    accounts: { value: accounts },
    options: { value: DEFAULT_CONFIG },
    disposed: { value: new AbortController() },
    pending: { value: new Map() },
    dispatchWaits: { value: new Map() },
    accountParents: { value: new Map() },
  })
  ;(service as any).registerTools()
  vi.mocked(catalogFor).mockResolvedValue(catalog)
  const worker: Worker = {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: agent.id,
    project,
    title: 'Synthetic worker',
    preference,
    mode: 'accept-edits',
    status: 'completed',
    conversationId: 'synthetic-conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  storage.save(worker)
  storage.bindAccount(worker.id, 'synthetic-settings-account')
  storage.append(worker, { kind: 'user', text: 'Synthetic question' })
  storage.append(worker, { kind: 'assistant', text: 'Synthetic answer' })
  const signal = new AbortController().signal
  return {
    project,
    storage,
    backend,
    runtime,
    service,
    worker,
    accounts,
    ask,
    jobs,
    signal,
    start: () =>
      tools
        .get('cliworker_start')
        .execute({ cli: 'antigravity', title: 'Synthetic', prompt: 'Synthetic task' }, { agent, signal }),
  }
}

describe('profile-wide CLI enablement', () => {
  it('defaults all CLIs on, persists independently, and stores only private validated booleans', () => {
    const { storage } = fixture()
    expect(storage.cliSettings().enabled).toEqual(Object.fromEntries(CLI_IDS.map((id) => [id, true])))
    storage.setCliEnabled('codex', false)
    const returned = storage.cliSettings()
    returned.enabled.antigravity = false
    expect(storage.cliSettings().enabled.antigravity).toBe(true)
    expect(statSync(join(storage.directory, 'cli-settings.json')).mode & 0o777).toBe(0o600)
    storage.close()
    const restored = new WorkerStorage(storage.directory)
    cleanups.push(() => restored.close())
    expect(restored.cliSettings().enabled.codex).toBe(false)
    expect(restored.cliSettings().enabled.antigravity).toBe(true)
    expect(() => restored.setCliEnabled('codex', 'false' as any)).toThrow()
    expect(() => restored.setCliEnabled('unknown' as any, true)).toThrow()
  })

  it('rejects corrupt settings without silently re-enabling a disabled CLI', () => {
    const { storage } = fixture()
    storage.close()
    writeFileSync(join(storage.directory, 'cli-settings.json'), '{"enabled":{"codex":"false"}}')
    expect(() => new WorkerStorage(storage.directory)).toThrow()
  })

  it('does not read or mutate CLI settings when the caller cancels during parent resolution', async () => {
    const { service, storage } = fixture()
    const parent = deferred<unknown>()
    ;(service as any).parent.mockReturnValue(parent.promise)
    const controller = new AbortController()
    const read = expect(service.cliSettings('parent', controller.signal)).rejects.toThrow('Caller closed')
    const write = expect(
      service.setCliEnabled('parent', 'antigravity', false, controller.signal),
    ).rejects.toThrow('Caller closed')
    controller.abort(new Error('Caller closed'))
    parent.resolve({ id: 'parent' })
    await Promise.all([read, write])
    expect(storage.cliSettings().enabled.antigravity).toBe(true)
  })

  it('disables dispatch and followup while retaining history, status, stop, and other CLIs', async () => {
    const { service, runtime, storage, project, worker, signal, start, backend, accounts } = fixture()
    const settings = JSON.parse(await service.setCliEnabled('parent', 'antigravity', false, signal))
    expect(settings.enabled.antigravity).toBe(false)
    expect(JSON.parse(await service.cliSettings('parent', signal))).toEqual(settings)
    await expect(start()).rejects.toThrow('已关闭')
    await expect(service.followup('parent', worker.id, 'Next', signal)).rejects.toThrow('已关闭')
    await expect(service.catalogForCli('parent', 'antigravity', signal)).rejects.toThrow('已关闭')
    await expect(service.catalog('parent', signal)).rejects.toThrow('已关闭')
    await expect(service.configure('parent', JSON.stringify(preference), signal)).rejects.toThrow('已关闭')
    await expect(
      service.configureWorker('parent', worker.id, JSON.stringify(preference), signal),
    ).rejects.toThrow('已关闭')
    await expect(service.accountStart('parent', 'antigravity', 'login', signal)).rejects.toThrow('已关闭')
    expect(() => runtime.submit('parent', project, 'New', 'Task', preference, 'accept-edits')).toThrow(
      '已关闭',
    )
    expect(catalogFor).not.toHaveBeenCalled()
    expect(backend.spawn).not.toHaveBeenCalled()
    expect(accounts.start).not.toHaveBeenCalled()
    const snapshot = runtime.snapshot('parent', worker.id)
    expect(snapshot.timeline.some((item) => item.text === 'Synthetic answer')).toBe(true)
    const anchor = snapshot.timeline.at(-1)!.id
    const history = JSON.parse(await service.history('parent', worker.id, anchor, 'before'))
    expect(history.items[0].text).toBe('Synthetic question')
    expect(JSON.parse(await service.stop('parent', worker.id)).status).toBe('completed')
    await expect(service.accountStatus('parent', 'antigravity', signal)).rejects.toThrow('已关闭')
    expect(accounts.status).not.toHaveBeenCalled()
    expect(storage.cliSettings().enabled.codex).toBe(true)
  })

  it('refuses disabling active tasks and pending account terminals without interrupting them', async () => {
    const { service, runtime, project, storage, accounts, signal } = fixture()
    const task = runtime.submit('parent', project, 'Queued', 'Task', preference, 'accept-edits')
    expect(() => runtime.setCliEnabled('antigravity', false)).toThrow('还有运行或排队')
    expect(task.worker.status).toBe('queued')
    await runtime.stop('parent', task.worker.id)
    accounts.isBusy.mockReturnValue(true)
    await expect(service.setCliEnabled('parent', 'antigravity', false, signal)).rejects.toThrow('账号终端')
    expect(storage.cliSettings().enabled.antigravity).toBe(true)
    accounts.isBusy.mockReturnValue(false)
    await service.setCliEnabled('parent', 'antigravity', false, signal)
    expect(storage.cliSettings().enabled.antigravity).toBe(false)
    expect(task.worker.status).toBe('interrupted')
  })

  it('does not publish a connected account status after the CLI is disabled during probing', async () => {
    const { service, signal, accounts } = fixture()
    const status = deferred<unknown>()
    accounts.status.mockReturnValueOnce(status.promise)
    const pending = service.accountStatus('parent', 'antigravity', signal)
    const rejected = expect(pending).rejects.toThrow('已关闭')
    await vi.waitFor(() => expect(accounts.status).toHaveBeenCalledTimes(1))
    await service.setCliEnabled('parent', 'antigravity', false, signal)
    status.resolve({ cli: 'antigravity', state: 'authenticated' })
    await rejected
  })

  it('checks disabled state after in-flight model discovery before asking for a model', async () => {
    const { service, start, ask, jobs, signal } = fixture()
    const loading = deferred<Catalog>()
    vi.mocked(catalogFor).mockReturnValueOnce(loading.promise)
    const pending = start()
    const rejected = expect(pending).rejects.toThrow('已关闭')
    await service.setCliEnabled('parent', 'antigravity', false, signal)
    loading.resolve(catalog)
    await rejected
    expect(ask).not.toHaveBeenCalled()
    expect(jobs.start).not.toHaveBeenCalled()
  })

  it('checks disabled state after model selection before persisting or publishing a task', async () => {
    const { service, start, ask, jobs, storage, project, signal } = fixture()
    const answer = deferred<unknown>()
    ask.mockReturnValueOnce(answer.promise)
    const pending = start()
    const rejected = expect(pending).rejects.toThrow('已关闭')
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    await service.setCliEnabled('parent', 'antigravity', false, signal)
    answer.resolve({ answers: [{ id: 'cliworker_model', selected: ['fixture'] }] })
    await rejected
    expect(storage.preference(project, 'antigravity')).toBeUndefined()
    expect(jobs.start).not.toHaveBeenCalled()
  })

  it('refuses a configuration change completed after the CLI was disabled', async () => {
    const { service, signal, storage, project } = fixture()
    const loading = deferred<Catalog>()
    vi.mocked(catalogFor).mockReturnValueOnce(loading.promise)
    const pending = service.configure('parent', JSON.stringify(preference), signal)
    const rejected = expect(pending).rejects.toThrow('已关闭')
    await vi.waitFor(() => expect(catalogFor).toHaveBeenCalledTimes(1))
    await service.setCliEnabled('parent', 'antigravity', false, signal)
    loading.resolve(catalog)
    await rejected
    expect(storage.preference(project, 'antigravity')).toBeUndefined()
  })

  it('refuses a followup after an in-flight lookup and resumes eligibility when re-enabled', async () => {
    const { service, signal, worker, jobs, runtime } = fixture()
    const loading = deferred<Catalog>()
    vi.mocked(catalogFor).mockReturnValueOnce(loading.promise)
    const pending = service.followup('parent', worker.id, 'Next task', signal)
    const rejected = expect(pending).rejects.toThrow('已关闭')
    await vi.waitFor(() => expect(catalogFor).toHaveBeenCalledTimes(1))
    await service.setCliEnabled('parent', 'antigravity', false, signal)
    loading.resolve(catalog)
    await rejected
    expect(jobs.start).not.toHaveBeenCalled()
    await service.setCliEnabled('parent', 'antigravity', true, signal)
    expect(() => runtime.assertCliEnabled('antigravity')).not.toThrow()
    await expect(service.catalogForCli('parent', 'antigravity', signal)).resolves.toContain('fixture')
  })
})

// Explicit synthetic account-supported catalog. No credential or model request.
describe('account-supported model selection', () => {
  it('rejects unbound legacy followup before querying models or creating a background job', async () => {
    const { service, storage, worker, signal, jobs, backend } = fixture()
    rmSync(join(storage.directory, `${worker.id}.account-binding.json`))
    const history = storage.history(worker.id)
    await expect(
      service.followup('parent', worker.id, 'Synthetic legacy continuation', signal),
    ).rejects.toThrow('此历史任务缺少账号记录')
    expect(catalogFor).not.toHaveBeenCalled()
    expect(jobs.start).not.toHaveBeenCalled()
    expect(backend.spawn).not.toHaveBeenCalled()
    expect(storage.history(worker.id)).toEqual(history)
  })

  const supported: Catalog = {
    cli: 'antigravity',
    models: [
      { id: 'paid/GLM-5.3-Flash', label: 'GLM-5.3-Flash（付费来源）', efforts: ['default'], cost: 'paid' },
      {
        id: 'native-free/glm-5.3-flash',
        label: 'GLM-5.3-Flash（免费来源）',
        efforts: ['default'],
        cost: 'free',
      },
      { id: 'paid/GLM-5.3', label: 'GLM-5.3 (provider)', efforts: ['default'], cost: 'unknown' },
    ],
    notice: '【模拟】仅已确认账号支持的模型',
  }

  it('asks complete setup using deduplicated names and saves the exact free route only after selection', async () => {
    const { service, ask, storage, project, signal, backend } = fixture()
    vi.mocked(catalogFor).mockResolvedValue(supported)
    ask
      .mockResolvedValueOnce({ answers: [{ id: 'cliworker_model', selected: ['GLM-5.3-Flash'] }] })
      .mockResolvedValueOnce({ answers: [{ id: 'cliworker_role', selected: ['不使用角色预设'] }] })
    const agent = await (service as any).parent('parent')
    const setup = await (service as any).chooseDispatch(agent, signal, 'antigravity')
    const chosen = setup.preference
    const options = ask.mock.calls[0]![0].questions[0].options
    expect(options).toEqual([{ label: 'GLM-5.3-Flash' }, { label: 'GLM-5.3' }])
    expect(chosen).toEqual({ cli: 'antigravity', model: 'native-free/glm-5.3-flash', effort: 'default' })
    expect(storage.preference(project, 'antigravity')).toEqual(chosen)
    expect(backend.spawn).not.toHaveBeenCalled()
  })

  it('keeps an explicitly saved valid paid route despite an equivalent free choice', async () => {
    const { service, ask, storage, project, signal, backend } = fixture()
    vi.mocked(catalogFor).mockResolvedValue(supported)
    const saved = { cli: 'antigravity' as const, model: 'paid/GLM-5.3-Flash', effort: 'default' as const }
    storage.setDispatchSetup(project, {
      preference: saved,
      role: null,
      binding: 'synthetic-settings-account',
    })
    ask.mockResolvedValue({ answers: [{ id: 'cliworker_reuse', selected: ['沿用'] }] })
    const agent = await (service as any).parent('parent')
    expect((await (service as any).chooseDispatch(agent, signal, 'antigravity')).preference).toEqual(saved)
    expect(storage.preference(project, 'antigravity')).toEqual(saved)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0].questions[0].id).toBe('cliworker_reuse')
    expect(backend.spawn).not.toHaveBeenCalled()
  })

  it('refuses obsolete unsupported configure and followup without changing selection or starting a process', async () => {
    const { service, storage, project, worker, signal, backend } = fixture()
    vi.mocked(catalogFor).mockResolvedValue(supported)
    storage.setPreference(project, worker.preference)
    await expect(service.configure('parent', JSON.stringify(worker.preference), signal)).rejects.toThrow(
      '不可用',
    )
    await expect(service.followup('parent', worker.id, '【模拟】继续', signal)).rejects.toThrow('不可用')
    expect(storage.preference(project, 'antigravity')).toEqual(worker.preference)
    expect(backend.spawn).not.toHaveBeenCalled()
  })
})

// Account identity is synthetic; these tests exercise actual directory and setting gates.
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: vi.fn(async () => 'synthetic-settings-account'),
}))
