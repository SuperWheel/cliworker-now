import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { CliWorkerService } from '../src/host/index.ts'
import { authorizedCatalog } from '../src/host/authorized-catalog.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import type { Worker } from '../src/shared/types.ts'

// Bounded synthetic state/streams only. Every native account and model transport is replaced.
const faults = vi.hoisted(() => ({
  admission: false,
  catalog: false,
  prepare: false,
  release: false,
  quiescent: true,
}))
vi.mock('../src/host/pi-omp-identity.ts', () => ({
  verifyPiOmpExecutable: async (_cli: string, executable: string) => executable,
}))
vi.mock('../src/host/cli-account-binding.ts', async () => {
  const { ProcessCleanupUnconfirmedError } = await import('../src/host/process.ts')
  return {
    readCliAccountBinding: async () => {
      if (faults.admission) throw new ProcessCleanupUnconfirmedError()
      return 'synthetic-own-account'
    },
  }
})
vi.mock('../src/host/authorized-catalog.ts', async () => {
  const { ProcessCleanupUnconfirmedError } = await import('../src/host/process.ts')
  return {
    ACCOUNT_CHANGED: 'Synthetic account changed',
    authorizeSelection: async (preference) => ({ binding: 'synthetic-own-account', preference }),
    authorizedCatalog: vi.fn(async (cli) => {
      if (faults.catalog) throw new ProcessCleanupUnconfirmedError()
      return { binding: 'synthetic-own-account', catalog: { cli, notice: 'Synthetic', models: [] } }
    }),
  }
})
vi.mock('../src/host/extended-adapters.ts', async () => {
  const { ProcessCleanupUnconfirmedError } = await import('../src/host/process.ts')
  return {
    isExtendedCli: (cli) => cli === 'omp',
    extendedLaunch: async () => {
      if (faults.prepare) throw new ProcessCleanupUnconfirmedError()
      if (faults.release)
        return {
          argv: ['/synthetic/omp', '--synthetic-fixture'],
          env: {},
          cleanup: async () => {
            throw new ProcessCleanupUnconfirmedError()
          },
        }
      throw new Error('This synthetic fixture does not run an extended CLI')
    },
  }
})

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  Object.assign(faults, { admission: false, catalog: false, prepare: false, release: false, quiescent: true })
  vi.restoreAllMocks()
  vi.mocked(authorizedCatalog).mockClear()
})
const preference = { cli: 'antigravity' as const, model: 'synthetic-model', effort: 'low' as const }

function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-cleanup-persistence-')))
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const directory = join(project, 'state')
  const storage = new WorkerStorage(directory)
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => '/synthetic/agy'),
    spawn: vi.fn((spec) => {
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      if (spec.argv[0] === '/synthetic/omp')
        stdout.end(
          JSON.stringify({ type: 'session', id: 'synthetic-session', model: preference.model }) +
            '\n' +
            JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'Synthetic result' }) +
            '\n',
        )
      else
        stdout.end(
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: 'synthetic-new-session',
              status: 'SUCCESS',
              response: 'Synthetic result',
            },
          }) + '\n',
        )
      stderr.end()
      return {
        stdout,
        stderr,
        done: Promise.resolve({ exitCode: 0 }),
        terminate: vi.fn(),
        waitForExit: async () => faults.quiescent,
      } as any
    }),
  }
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  const serviceFor = (current: WorkerRuntime) => {
    const service: any = Object.create(CliWorkerService.prototype)
    Object.assign(service, {
      runtime: current,
      backend,
      options: DEFAULT_CONFIG,
      parent: async (id) => ({
        id,
        session: { header: { cwd: project, origin: 'user' } },
        ctx: {
          get: (name) =>
            name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined,
        },
      }),
      disposed: new AbortController(),
    })
    return service
  }
  const signal = new AbortController().signal
  const legacy: Worker = {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: 'parent',
    project,
    title: 'Synthetic legacy',
    agentName: 'legacy-custom',
    agentNameOrigin: 'custom',
    status: 'completed',
    mode: 'accept-edits',
    preference,
    conversationId: 'synthetic-original-session',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
  }
  const reopen = async () => {
    await runtime.close()
    const reopened = new WorkerStorage(directory)
    const rebuilt = new WorkerRuntime(reopened, backend, DEFAULT_CONFIG)
    cleanups.push(() => rebuilt.close())
    return { reopened, rebuilt, service: serviceFor(rebuilt) }
  }
  return {
    project,
    directory,
    storage,
    runtime,
    backend,
    signal,
    legacy,
    reopen,
    service: serviceFor(runtime),
  }
}

describe('durable Host cleanup quarantine', () => {
  it('persists only a private safety marker and refuses management, restart, accounts and task admission after reconstruction', async () => {
    const f = fixture()
    f.storage.save(f.legacy)
    const archived = {
      ...f.legacy,
      id: randomUUID(),
      agentName: 'archived-custom',
      archivedAt: new Date().toISOString(),
    }
    f.storage.save(archived)
    f.storage.append(f.legacy, { kind: 'assistant', text: 'Synthetic retained history' })
    f.runtime.blockOnCleanup(new ProcessCleanupUnconfirmedError())
    const marker = join(f.directory, 'cleanup-blocked.json')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ policy: 1, state: 'cleanup-unconfirmed' })
    expect(statSync(f.directory).mode & 0o777).toBe(0o700)
    expect(statSync(marker).mode & 0o777).toBe(0o600)
    const { reopened, rebuilt, service } = await f.reopen()
    expect(reopened.cleanupBlockState()).toBe('blocked')
    expect(() => rebuilt.deleteWorker('parent', f.legacy.id)).toThrow('清理')
    expect(() => rebuilt.restoreWorker('parent', archived.id)).toThrow('清理')
    await expect(service.restartWorker('parent', f.legacy.id, 'Synthetic', f.signal)).rejects.toThrow('清理')
    expect(() => rebuilt.assertAccountIdle('antigravity')).toThrow('清理')
    expect(() => rebuilt.assertCliEnabled('codex')).toThrow('清理')
    expect(() =>
      rebuilt.submit('parent', f.project, 'Synthetic', 'Synthetic', preference, 'accept-edits'),
    ).toThrow('清理')
    expect(reopened.history(f.legacy.id)).toHaveLength(1)
    expect(reopened.accountBinding(f.legacy.id)).toBeUndefined()
    expect(reopened.workers.get(archived.id)?.archivedAt).toBe(archived.archivedAt)
    expect(f.backend.spawn).not.toHaveBeenCalled()
    await rebuilt.close()
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ policy: 1, state: 'cleanup-unconfirmed' })
  })

  it('a catalog cleanup failure without any Worker remains blocked after Host reconstruction', async () => {
    const f = fixture()
    faults.catalog = true
    await expect(f.service.catalogForCli('parent', 'antigravity', f.signal)).rejects.toThrow('cleanup')
    expect(f.storage.workers.size).toBe(0)
    const { rebuilt, reopened, service } = await f.reopen()
    expect(reopened.cleanupBlockState()).toBe('blocked')
    faults.catalog = false
    await expect(service.catalogForCli('parent', 'codex', f.signal)).rejects.toThrow('清理')
    expect(authorizedCatalog).toHaveBeenCalledTimes(1)
    expect(() => rebuilt.assertAccountIdle('codex')).toThrow('清理')
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })

  it.each(['admission', 'prepare', 'process-exit', 'account-release'] as const)(
    'records explicit unconfirmed %s cleanup at its Runtime source',
    async (source) => {
      const f = fixture()
      if (source === 'admission') faults.admission = true
      if (source === 'prepare') faults.prepare = true
      if (source === 'account-release') faults.release = true
      if (source === 'process-exit') faults.quiescent = false
      const selection =
        source === 'prepare' || source === 'account-release'
          ? { ...preference, cli: 'omp' as const }
          : preference
      const task = f.runtime.submit(
        'parent',
        f.project,
        'Synthetic',
        'Synthetic task',
        selection,
        'accept-edits',
      )
      expect((await task.done).status).toBe('failed')
      expect(f.storage.cleanupBlockState()).toBe('blocked')
      const { rebuilt } = await f.reopen()
      expect(() => rebuilt.assertAccountIdle('antigravity')).toThrow('清理')
      expect(() => rebuilt.deleteWorker('parent', task.worker.id)).toThrow('清理')
      expect(f.backend.spawn).toHaveBeenCalledTimes(
        source === 'process-exit' || source === 'account-release' ? 1 : 0,
      )
    },
  )

  it.each([
    'truncated-json',
    'wrong-policy',
    'unexpected-state',
    'extra-data',
    'oversized',
    'symlink',
  ] as const)('fails closed for %s quarantine data', async (corruption) => {
    const f = fixture()
    const marker = join(f.directory, 'cleanup-blocked.json')
    if (corruption === 'symlink') {
      const target = join(f.project, 'synthetic-target.json')
      writeFileSync(target, JSON.stringify({ policy: 1, state: 'cleanup-unconfirmed' }))
      symlinkSync(target, marker)
    } else {
      const value = {
        'truncated-json': '{',
        'wrong-policy': JSON.stringify({ policy: 2, state: 'cleanup-unconfirmed' }),
        'unexpected-state': JSON.stringify({ policy: 1, state: 'clean' }),
        'extra-data': JSON.stringify({ policy: 1, state: 'cleanup-unconfirmed', unexpected: true }),
        oversized: 'x'.repeat(1025),
      }[corruption]
      writeFileSync(marker, value)
    }
    const { reopened, rebuilt, service } = await f.reopen()
    expect(reopened.cleanupBlockState()).toBe('invalid')
    expect(() => rebuilt.assertAccountIdle('antigravity')).toThrow('隔离记录无法核验')
    expect(() =>
      rebuilt.submit('parent', f.project, 'Synthetic', 'Synthetic', preference, 'accept-edits'),
    ).toThrow('隔离记录无法核验')
    await expect(service.catalogForCli('parent', 'antigravity', f.signal)).rejects.toThrow('隔离记录无法核验')
    expect(authorizedCatalog).not.toHaveBeenCalled()
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })

  it('does not infer quarantine from historical error text when no explicit marker exists', async () => {
    const f = fixture()
    f.storage.save({
      ...f.legacy,
      status: 'failed',
      error: '无法确认 CLI 进程已清理，已暂停后续派遣：Synthetic historical text',
    })
    const { reopened, rebuilt } = await f.reopen()
    expect(reopened.cleanupBlockState()).toBe('none')
    expect(() => rebuilt.assertAccountIdle('antigravity')).not.toThrow()
    expect(() => rebuilt.deleteWorker('parent', f.legacy.id)).not.toThrow()
  })

  it('keeps the current Host closed and reports persistence failure when quarantine cannot be written', () => {
    const f = fixture()
    f.storage.save(f.legacy)
    vi.spyOn(f.storage, 'blockCleanup').mockImplementationOnce(() => {
      throw new Error('Synthetic disk failure')
    })
    f.runtime.blockOnCleanup(new ProcessCleanupUnconfirmedError())
    expect(() => f.runtime.assertAccountIdle('antigravity')).toThrow('隔离记录保存失败')
    expect(() => f.runtime.deleteWorker('parent', f.legacy.id)).toThrow('隔离记录保存失败')
    expect(() =>
      f.runtime.submit('parent', f.project, 'Synthetic', 'Synthetic', preference, 'accept-edits'),
    ).toThrow('隔离记录保存失败')
    expect(f.storage.cleanupBlockState()).toBe('none')
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })
})
