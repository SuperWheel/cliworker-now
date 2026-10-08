import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { extendedLaunch } from '../src/host/extended-adapters.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'

// Synthetic preparation only: this suite never invokes an installed CLI or reads its accounts.
vi.mock('../src/host/pi-omp-identity.ts', () => ({
  verifyPiOmpExecutable: async (_cli: string, executable: string) => executable,
}))
vi.mock('../src/host/extended-adapters.ts', () => ({
  isExtendedCli: (cli: string) => cli === 'omp',
  extendedLaunch: vi.fn(),
  extendedCatalog: vi.fn(() => {
    throw new Error('Synthetic runtime suite must not discover native accounts')
  }),
}))

const launch = vi.mocked(extendedLaunch)
const cleanups: (() => void | Promise<void>)[] = []
const preference = { cli: 'omp' as const, model: 'synthetic-provider/model', effort: 'default' as const }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cliworker-runtime-metadata-synthetic-')))
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(project, { mode: 0o700 })
  mkdirSync(home, { mode: 0o700 })
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'))
  vi.stubEnv('XDG_DATA_HOME', join(home, 'data'))
  vi.stubEnv('DSH_HOME', join(home, 'dsh'))
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => '/synthetic/omp'),
    spawn: vi.fn(() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      stdout.end(
        JSON.stringify({ type: 'session', id: 'synthetic-session', model: preference.model }) +
          '\n' +
          JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'Synthetic next task completed' }) +
          '\n',
      )
      stderr.end()
      return {
        stdout,
        stderr,
        done: Promise.resolve({ exitCode: 0 }),
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      } as unknown as SubprocessHandle
    }),
  }
  const storage = new WorkerStorage(join(root, 'state'))
  const runtime = new WorkerRuntime(storage, backend, {
    ...DEFAULT_CONFIG,
    maxConcurrent: 1,
    stateDirectory: join(root, 'state'),
    ompExecutable: '/synthetic/omp',
  })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => runtime.close())
  const submit = (title = 'Synthetic metadata task') =>
    runtime.submit('synthetic-parent', project, title, 'Synthetic prompt only', preference, 'accept-edits')
  return { runtime, backend, storage, submit }
}

function safeLaunch(cleanup = vi.fn()) {
  return { argv: ['/synthetic/omp', '--synthetic-fixture'], env: {}, cleanup }
}

beforeEach(() => launch.mockReset())
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

describe('metadata preparation cleanup admission, isolated synthetic fixtures', () => {
  it.each([false, true])(
    'reports failed and blocks queued work and account mutation after unconfirmed preparation cleanup (stop=%s)',
    async (stopWhilePreparing) => {
      const { runtime, backend, storage, submit } = setup()
      const prepared = deferred<Awaited<ReturnType<typeof extendedLaunch>>>()
      launch.mockImplementationOnce(() => prepared.promise)
      const first = submit()
      const queued = submit('Synthetic queued task')
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
      expect(first.worker.status).toBe('running')
      expect(queued.worker.status).toBe('queued')
      const stopping = stopWhilePreparing ? runtime.stop('synthetic-parent', first.worker.id) : undefined
      if (stopping) expect(first.worker.status).toBe('stopping')
      const cleanupFailure = new ProcessCleanupUnconfirmedError()
      prepared.reject(cleanupFailure)

      const failed = await first.done
      expect(failed.status).toBe('failed')
      expect(failed.error).toContain(cleanupFailure.message)
      if (stopping) expect(await stopping).toEqual(failed)
      expect(await runtime.stop('synthetic-parent', first.worker.id)).toEqual(failed)
      const rejectedQueue = await queued.done
      expect(rejectedQueue.status).toBe('failed')
      expect(rejectedQueue.error).toBe(failed.error)
      expect(storage.history(first.worker.id).at(-1)).toMatchObject({ state: 'failed', text: failed.error })
      expect(backend.spawn).not.toHaveBeenCalled()
      expect(launch).toHaveBeenCalledTimes(1)
      expect(backend.resolveExecutable).toHaveBeenCalledTimes(1)

      expect(() => submit('Synthetic later task')).toThrow(failed.error!)
      for (const cli of ['omp', 'pi', 'opencode']) {
        expect(() => runtime.assertAccountIdle(cli)).toThrow(failed.error!)
      }
      const enabledBefore = structuredClone(storage.cliSettings())
      expect(() => runtime.setCliEnabled('omp', false)).toThrow(failed.error!)
      expect(storage.cliSettings()).toEqual(enabledBefore)
      expect(backend.spawn).not.toHaveBeenCalled()
    },
  )

  it('safe preparation cleanup after cancellation releases state and permits the next queued task', async () => {
    const { runtime, backend, submit } = setup()
    const prepared = deferred<Awaited<ReturnType<typeof extendedLaunch>>>()
    const release = vi.fn()
    launch.mockImplementationOnce(() => prepared.promise).mockResolvedValue(safeLaunch())
    const first = submit()
    const next = submit('Synthetic next task')
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    const stopped = runtime.stop('synthetic-parent', first.worker.id)
    prepared.resolve(safeLaunch(release))

    expect(await stopped).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('用户已停止任务'),
    })
    expect(release).toHaveBeenCalledTimes(1)
    expect(await next.done).toMatchObject({
      status: 'completed',
      lastResult: 'Synthetic next task completed',
    })
    expect(backend.spawn).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(() => runtime.assertAccountIdle('omp')).not.toThrow()
    expect(() => runtime.setCliEnabled('omp', false)).not.toThrow()
  })

  it('an ordinary cancelled preparation rejection does not poison queue or account admission', async () => {
    const { runtime, backend, submit } = setup()
    const prepared = deferred<Awaited<ReturnType<typeof extendedLaunch>>>()
    launch.mockImplementationOnce(() => prepared.promise).mockResolvedValue(safeLaunch())
    const first = submit()
    const next = submit('Synthetic next task')
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    const stopped = runtime.stop('synthetic-parent', first.worker.id)
    prepared.reject(new Error('Synthetic metadata cancelled after confirmed cleanup'))

    expect(await stopped).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('用户已停止任务'),
    })
    expect((await next.done).status).toBe('completed')
    expect(backend.spawn).toHaveBeenCalledTimes(1)
    expect(() => runtime.assertAccountIdle('omp')).not.toThrow()
    expect(() => runtime.setCliEnabled('omp', false)).not.toThrow()
  })

  it('a normal preparation error fails that task while the queue remains usable', async () => {
    const { runtime, backend, submit } = setup()
    launch
      .mockRejectedValueOnce(new Error('Synthetic invalid model configuration'))
      .mockResolvedValue(safeLaunch())
    const first = submit()
    const next = submit('Synthetic next task')

    expect(await first.done).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Synthetic invalid model configuration'),
    })
    expect((await next.done).status).toBe('completed')
    expect(backend.spawn).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(() => runtime.assertAccountIdle('omp')).not.toThrow()
    expect((await submit('Synthetic later task').done).status).toBe('completed')
    expect(backend.spawn).toHaveBeenCalledTimes(2)
  })
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
