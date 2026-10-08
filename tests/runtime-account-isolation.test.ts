import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { catalogFor } from '../src/host/adapters.ts'
import { readCliAccountBinding } from '../src/host/cli-account-binding.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import { CLI_IDS, type Preference } from '../src/shared/types.ts'

// Synthetic account metadata and process streams, with the real authorization/runtime guards.
vi.mock('../src/host/adapters.ts', async (original) => ({
  ...(await original<object>()),
  catalogFor: vi.fn(),
}))
vi.mock('../src/host/cli-account-binding.ts', () => ({ readCliAccountBinding: vi.fn() }))
const cleanup: (() => void | Promise<void>)[] = []
let account: string | undefined
let models = ['synthetic/model']
let efforts = ['low'] as ('low' | 'high')[]
const preference: Preference = { cli: 'antigravity', model: 'synthetic/model', effort: 'low' }

beforeEach(() => {
  account = 'synthetic-account-a'
  models = ['synthetic/model']
  efforts = ['low']
  vi.mocked(readCliAccountBinding).mockImplementation(async (_cli, _backend, _config, _project, signal) => {
    signal.throwIfAborted()
    if (!account) throw new Error('本 CLI 未登录')
    return account
  })
  vi.mocked(catalogFor).mockImplementation(async (cli) => ({
    cli,
    notice: 'Synthetic current account scope',
    models: models.map((id) => ({ id, label: id, efforts })),
  }))
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.resetAllMocks()
})

function setup() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-own-account-synthetic-')))
  cleanup.push(() => rmSync(project, { recursive: true, force: true }))
  const finishes: (() => void)[] = []
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => '/synthetic/agy'),
    spawn: vi.fn(() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let resolve!: (value: { exitCode: number }) => void
      const done = new Promise<{ exitCode: number }>((yes) => {
        resolve = yes
      })
      const finish = () => {
        stdout.end(
          JSON.stringify({ event: 'init', conversation_id: 'synthetic-session' }) +
            '\n' +
            JSON.stringify({
              event: 'result',
              result: { conversation_id: 'synthetic-session', status: 'SUCCESS', response: 'Synthetic only' },
            }) +
            '\n',
        )
        stderr.end()
        resolve({ exitCode: 0 })
      }
      finishes.push(finish)
      return {
        stdout,
        stderr,
        done,
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      } as unknown as SubprocessHandle
    }),
  }
  const storage = new WorkerStorage(join(project, 'state'))
  const runtime = new WorkerRuntime(storage, backend, { ...DEFAULT_CONFIG, maxConcurrent: 1 })
  cleanup.push(() => runtime.close())
  const submit = (selection = preference, previousId?: string) =>
    runtime.submit(
      'synthetic-parent',
      project,
      'Synthetic account task',
      'Synthetic prompt',
      selection,
      'accept-edits',
      previousId,
    )
  return { backend, runtime, storage, finishes, submit }
}

it.each(CLI_IDS)(
  '%s cannot start or restore a historical account from an unrelated credential',
  async (cli) => {
    const { backend, submit } = setup()
    account = undefined
    const task = submit({ ...preference, cli })
    expect(await task.done).toMatchObject({ status: 'failed', error: expect.stringContaining('未登录') })
    expect(backend.spawn).not.toHaveBeenCalled()
    expect(catalogFor).not.toHaveBeenCalled()
  },
)

it.each(['logout', 'switch', 'model', 'effort'])('rechecks %s after waiting in the queue', async (change) => {
  const { backend, finishes, submit } = setup()
  const first = submit()
  await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledTimes(1))
  const second = submit()
  // Admission captures A; the queued turn must not adopt a later account or scope.
  await Promise.resolve()
  if (change === 'logout') account = undefined
  if (change === 'switch') account = 'synthetic-account-b'
  if (change === 'model') models = ['synthetic/another-model']
  if (change === 'effort') efforts = ['high']
  finishes[0]!()
  expect((await first.done).status).toBe('completed')
  expect((await second.done).status).toBe('failed')
  expect(backend.spawn).toHaveBeenCalledTimes(1)
})

it('rechecks the account after native launch preparation and sends no prompt if it changed', async () => {
  const { backend, submit } = setup()
  vi.mocked(backend.resolveExecutable).mockImplementation(async () => {
    account = 'synthetic-account-b'
    return '/synthetic/agy'
  })
  expect(await submit().done).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('账号已变更'),
  })
  expect(backend.spawn).not.toHaveBeenCalled()
})

it('rejects a raw model variant paired with another variant effort instead of substituting it', async () => {
  const { backend, submit } = setup()
  vi.mocked(catalogFor).mockResolvedValue({
    cli: 'antigravity',
    notice: 'Synthetic variants',
    models: [
      {
        id: 'synthetic/group',
        label: 'Synthetic',
        efforts: ['low', 'high'],
        variants: { low: 'synthetic/low', high: 'synthetic/high' },
      },
    ],
  })
  expect(await submit({ ...preference, model: 'synthetic/high', effort: 'low' }).done).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('不匹配'),
  })
  expect(backend.spawn).not.toHaveBeenCalled()
})

it('binds history privately, permits the same account and refuses a replacement account on continuation', async () => {
  const { backend, storage, runtime, finishes, submit } = setup()
  const first = submit()
  await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledTimes(1))
  finishes[0]!()
  await first.done
  expect(storage.accountBinding(first.worker.id)).toBe('synthetic-account-a')
  expect(statSync(join(storage.directory, `${first.worker.id}.account-binding.json`)).mode & 0o777).toBe(
    0o600,
  )
  expect(JSON.stringify(runtime.snapshot('synthetic-parent', first.worker.id))).not.toContain(
    'synthetic-account-a',
  )
  const same = submit(preference, first.worker.id)
  await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledTimes(2))
  finishes[1]!()
  expect((await same.done).status).toBe('completed')
  account = 'synthetic-account-b'
  const different = submit(preference, first.worker.id)
  expect(await different.done).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('账号已变更'),
  })
  expect(backend.spawn).toHaveBeenCalledTimes(2)
})

it('cancels during model discovery without spawning a task', async () => {
  const { backend, runtime, submit } = setup()
  vi.mocked(catalogFor).mockImplementation(async (_cli, _backend, _config, _project, signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
    throw new Error('unreachable')
  })
  const task = submit()
  await vi.waitFor(() => expect(catalogFor).toHaveBeenCalledTimes(1))
  expect((await runtime.stop('synthetic-parent', task.worker.id)).status).toBe('interrupted')
  expect(backend.spawn).not.toHaveBeenCalled()
})

it.each([false, true])(
  'queued cancellation waits for account-query cleanup (failure=%s)',
  async (failure) => {
    const { backend, runtime, finishes, submit } = setup()
    const first = submit()
    await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledTimes(1))
    let reject!: (reason: unknown) => void
    vi.mocked(readCliAccountBinding).mockImplementationOnce(
      () =>
        new Promise((_yes, no) => {
          reject = no
        }),
    )
    const queued = submit()
    let settled = false
    void queued.done.then(() => {
      settled = true
    })
    const stopping = runtime.stop('synthetic-parent', queued.worker.id)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(queued.worker.status).toBe('stopping')
    reject(failure ? new ProcessCleanupUnconfirmedError() : new Error('Synthetic query safely cancelled'))
    expect((await stopping).status).toBe(failure ? 'failed' : 'interrupted')
    if (failure) expect(() => submit()).toThrow('清理')
    finishes[0]!()
    await first.done
    expect(backend.spawn).toHaveBeenCalledTimes(1)
  },
)
