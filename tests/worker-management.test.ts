import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { CliWorkerService } from '../src/host/index.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import { validatePreference } from '../src/host/adapters.ts'
import { CLI_IDS, CLI_SHORT_NAMES, effortLabel, workerName, type Worker } from '../src/shared/types.ts'

// Explicit synthetic account epochs, streams and storage. No user state or native model call.
const account = vi.hoisted(() => ({ current: 'synthetic-account-a' as string | undefined }))
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async () => {
    if (!account.current) throw new Error('请登录自身账号')
    return account.current
  },
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: '账号已变更',
  authorizeSelection: async (
    preference: unknown,
    _backend: unknown,
    _config: unknown,
    _project: unknown,
    signal: AbortSignal,
    expected: string,
  ) => {
    signal.throwIfAborted()
    if (!account.current || account.current !== expected) throw new Error('账号已变更')
    return { binding: account.current, preference }
  },
}))

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  account.current = 'synthetic-account-a'
  vi.restoreAllMocks()
})

function storedWorker(project: string, fields: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: 'parent',
    project,
    title: 'Synthetic chat',
    preference: { cli: 'antigravity', model: 'synthetic-model', effort: 'low' },
    mode: 'accept-edits',
    status: 'completed',
    conversationId: 'synthetic-old-conversation',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
    ...fields,
  }
}

function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-worker-management-')))
  const directory = join(project, 'state')
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const storage = new WorkerStorage(directory)
  const calls: Array<{ argv: readonly string[]; finish: () => void }> = []
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => '/synthetic/agy'),
    spawn: vi.fn((spec) => {
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let complete!: (value: { exitCode: number }) => void
      const done = new Promise<{ exitCode: number }>((resolve) => (complete = resolve))
      const end = (exitCode: number) => {
        stdout.end()
        stderr.end()
        complete({ exitCode })
      }
      calls.push({
        argv: spec.argv,
        finish: () => {
          stdout.write(
            JSON.stringify({
              event: 'result',
              result: {
                conversation_id: 'synthetic-new-conversation',
                status: 'SUCCESS',
                response: 'Synthetic result',
              },
            }) + '\n',
          )
          end(0)
        },
      })
      const terminate = () => end(143)
      spec.signal?.addEventListener('abort', terminate, { once: true })
      return {
        stdout,
        stderr,
        done,
        terminate,
        waitForExit: async () => {
          await done
          return true
        },
      } as any
    }),
  }
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  const jobs = {
    start: vi.fn((spec) => {
      spec.run()
      return 'synthetic-job'
    }),
  }
  const policy = { mode: 'workspace-write' }
  const agent = {
    id: 'parent',
    session: { header: { cwd: project, origin: 'user' } },
    ctx: {
      get: (name: string) =>
        name === 'jobs' ? jobs : name === 'sandboxPolicy' ? { resolve: () => policy } : undefined,
    },
  }
  const service: any = Object.create(CliWorkerService.prototype)
  Object.assign(service, {
    runtime,
    backend,
    options: DEFAULT_CONFIG,
    disposed: new AbortController(),
    accounts: { isBusy: vi.fn(() => false) },
    parent: vi.fn(async (id) => ({ ...agent, id })),
    querySelection: vi.fn(async (preference, _backend, _config, _project, signal, expected) => {
      signal.throwIfAborted()
      if (!account.current) throw new Error('请登录自身账号')
      if (expected && expected !== account.current) throw new Error('账号已变更')
      validatePreference(preference, {
        cli: preference.cli,
        notice: 'Synthetic',
        models: [{ id: 'synthetic-model', label: 'Synthetic model', efforts: ['low'] }],
      })
      return { binding: account.current, preference }
    }),
  })
  const signal = new AbortController().signal
  return { project, directory, storage, runtime, backend, calls, jobs, service, signal, agent, policy }
}

describe('short default names and exact legacy references', () => {
  it.each(CLI_IDS)('allocates %s names independently of role names', (cli) => {
    const f = fixture()
    const role = { name: 'Synthetic long role', summary: 'Synthetic', prompt: 'Synthetic role' }
    const first = f.runtime.submit(
      'parent',
      f.project,
      'Synthetic',
      'Synthetic task',
      { cli, model: 'synthetic-model', effort: 'low' },
      'accept-edits',
      undefined,
      { role },
      'synthetic-account-a',
    )
    const second = f.runtime.submit(
      'parent',
      f.project,
      'Synthetic',
      'Synthetic task',
      { cli, model: 'synthetic-model', effort: 'low' },
      'accept-edits',
      undefined,
      { role },
      'synthetic-account-a',
    )
    expect(first.worker.agentName).toBe(`${CLI_SHORT_NAMES[cli]}-1`)
    expect(second.worker.agentName).toBe(`${CLI_SHORT_NAMES[cli]}-2`)
    expect(first.worker.agentNameOrigin).toBe('auto')
    expect(first.worker.role).toEqual(role)
  })

  it('migrates only unnamed and strict former CLI defaults, reserves hidden names/aliases, and persists idempotently', () => {
    const f = fixture()
    const unnamed = storedWorker(f.project, { preference: { model: 'synthetic-model', effort: 'low' } })
    const old = storedWorker(f.project, { agentName: 'Antigravity助手-1' })
    const custom = storedWorker(f.project, { agentName: 'Antigravity助手-3', agentNameOrigin: 'custom' })
    const roleName = storedWorker(f.project, {
      agentName: 'Synthetic reviewer-1',
      role: { name: 'Synthetic reviewer', summary: 'Synthetic', prompt: 'Synthetic' },
    })
    const occupied = storedWorker(f.project, {
      agentName: 'agy-1',
      archivedAt: new Date().toISOString(),
      nameAliases: ['agy-2'],
    })
    for (const worker of [unnamed, old, custom, roleName, occupied]) f.storage.save(worker)
    f.storage.append(old, { kind: 'assistant', text: 'Synthetic retained history' })
    f.storage.bindAccount(old.id, 'synthetic-original-account')
    const events = readFileSync(join(f.directory, `${old.id}.events.jsonl`), 'utf8')
    f.storage.close()
    const reopened = new WorkerStorage(f.directory)
    cleanups.push(() => reopened.close())
    const migratedOld = reopened.workers.get(old.id)!,
      migratedUnnamed = reopened.workers.get(unnamed.id)!
    expect([migratedOld.agentName, migratedUnnamed.agentName].sort()).toEqual(['agy-3', 'agy-4'])
    expect(migratedOld.nameAliases).toContain('Antigravity助手-1')
    expect(migratedUnnamed.nameAliases).toContain(workerName(unnamed))
    expect(reopened.workers.get(custom.id)).toEqual(custom)
    expect(reopened.workers.get(roleName.id)).toEqual(roleName)
    expect(reopened.workers.get(occupied.id)).toEqual(occupied)
    expect(reopened.accountBinding(old.id)).toBe('synthetic-original-account')
    expect(readFileSync(join(f.directory, `${old.id}.events.jsonl`), 'utf8')).toBe(events)
    const runtime = new WorkerRuntime(reopened, f.backend, DEFAULT_CONFIG)
    expect(runtime.resolveWorker('parent', undefined, 'Antigravity助手-1').id).toBe(old.id)
    expect(runtime.resolveWorker('parent', old.id, 'Antigravity助手-1').id).toBe(old.id)
    expect(() => runtime.resolveWorker('other-parent', undefined, 'Antigravity助手-1')).toThrow()
    expect(() => runtime.renameWorker('parent', custom.id, 'Antigravity助手-1')).toThrow('同名')
    const bytes = readFileSync(join(f.directory, `${old.id}.worker.json`), 'utf8')
    reopened.close()
    const again = new WorkerStorage(f.directory)
    cleanups.push(() => again.close())
    expect(readFileSync(join(f.directory, `${old.id}.worker.json`), 'utf8')).toBe(bytes)
  })

  it('does not migrate ambiguous duplicates or near-matches to the old default format', () => {
    const f = fixture()
    const first = storedWorker(f.project, { agentName: 'Antigravity助手-1' })
    const duplicate = storedWorker(f.project, { agentName: 'Antigravity助手-1' })
    const near = storedWorker(f.project, { agentName: 'Antigravity助手-01' })
    for (const worker of [first, duplicate, near]) f.storage.save(worker)
    f.storage.close()
    const reopened = new WorkerStorage(f.directory)
    cleanups.push(() => reopened.close())
    for (const worker of [first, duplicate, near]) expect(reopened.workers.get(worker.id)).toEqual(worker)
    const runtime = new WorkerRuntime(reopened, f.backend, DEFAULT_CONFIG)
    expect(() => runtime.resolveWorker('parent', undefined, 'Antigravity助手-1')).toThrow('不唯一')
  })

  it('keeps protocol effort values while formatting display labels', () => {
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('xhigh')).toBe('Xhigh')
    expect(effortLabel('default')).toBe('默认')
  })
})

describe('private account admission and reversible management', () => {
  it('projects a safe selected-history reason and never invents a binding', () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    expect(f.runtime.snapshot('parent', worker.id).resumeBlockedReason).toContain('缺少账号记录')
    expect(f.storage.accountBinding(worker.id)).toBeUndefined()
    f.storage.bindAccount(worker.id, 'synthetic-account-a')
    expect(f.runtime.snapshot('parent', worker.id).resumeBlockedReason).toBeUndefined()
    expect(JSON.stringify(f.runtime.snapshot('parent', worker.id))).not.toContain('synthetic-account-a')
  })

  it('changes only a valid title, keeps identity/history, and leaves memory untouched after disk failure', () => {
    const f = fixture(),
      worker = storedWorker(f.project, { agentName: 'custom-name' })
    f.storage.save(worker)
    f.storage.append(worker, { kind: 'assistant', text: 'Synthetic retained history' })
    const before = f.storage.history(worker.id)
    f.runtime.renameWorkerTitle('parent', worker.id, '  Updated title  ')
    expect(f.runtime.get('parent', worker.id)).toMatchObject({
      title: 'Updated title',
      agentName: 'custom-name',
      conversationId: worker.conversationId,
    })
    expect(f.storage.history(worker.id)).toEqual(before)
    for (const title of ['', 'a\nb', 'a\rb', 'x'.repeat(161)])
      expect(() => f.runtime.renameWorkerTitle('parent', worker.id, title)).toThrow()
    expect(() => f.runtime.renameWorkerTitle('other-parent', worker.id, 'New')).toThrow('does not belong')
    vi.spyOn(f.storage, 'save').mockImplementationOnce(() => {
      throw new Error('Synthetic disk failure')
    })
    expect(() => f.runtime.renameWorkerTitle('parent', worker.id, 'Failed title')).toThrow('disk failure')
    expect(f.runtime.get('parent', worker.id).title).toBe('Updated title')
  })

  it('deletes and restores the same persisted Worker without deleting its history, binding or name reservation', () => {
    const f = fixture(),
      worker = storedWorker(f.project, { agentName: 'agy-1', nameAliases: ['Antigravity助手-1'] })
    f.storage.save(worker)
    f.storage.append(worker, { kind: 'assistant', text: 'Synthetic retained history' })
    f.storage.bindAccount(worker.id, 'synthetic-account-a')
    f.runtime.deleteWorker('parent', worker.id)
    const snapshot = f.runtime.snapshot('parent', worker.id)
    expect(snapshot.workers).toEqual([])
    expect(snapshot.archivedWorkers?.[0]).toMatchObject({ id: worker.id, archivedAt: expect.any(String) })
    expect(snapshot.selected).toBeUndefined()
    expect(() => f.runtime.get('parent', worker.id)).toThrow('已删除')
    expect(() => f.runtime.resolveWorker('parent', undefined, 'Antigravity助手-1')).toThrow('没有此名称')
    expect(() =>
      f.runtime.submit(
        'parent',
        f.project,
        'Synthetic',
        'Synthetic',
        worker.preference,
        'accept-edits',
        worker.id,
      ),
    ).toThrow('已删除')
    const other = storedWorker(f.project, { agentName: 'custom-name' })
    f.storage.save(other)
    expect(() => f.runtime.renameWorker('parent', other.id, 'agy-1')).toThrow('同名')
    expect(() => f.runtime.renameWorker('parent', other.id, 'Antigravity助手-1')).toThrow('同名')
    expect(f.storage.history(worker.id)).toHaveLength(1)
    expect(f.storage.accountBinding(worker.id)).toBe('synthetic-account-a')
    f.storage.close()
    const reopened = new WorkerStorage(f.directory)
    cleanups.push(() => reopened.close())
    const runtime = new WorkerRuntime(reopened, f.backend, DEFAULT_CONFIG)
    expect(runtime.snapshot('parent').archivedWorkers?.[0]?.id).toBe(worker.id)
    expect(() => runtime.restoreWorker('other-parent', worker.id)).toThrow('does not belong')
    runtime.restoreWorker('parent', worker.id)
    expect(runtime.get('parent', worker.id)).toMatchObject({
      id: worker.id,
      conversationId: worker.conversationId,
    })
    expect(runtime.snapshot('parent').archivedWorkers).toEqual([])
    expect(reopened.history(worker.id)).toHaveLength(1)
    expect(reopened.accountBinding(worker.id)).toBe('synthetic-account-a')
  })

  it.each(['queued', 'running', 'stopping'] as const)(
    'refuses %s deletion and cross-parent requests',
    (status) => {
      const f = fixture(),
        worker = storedWorker(f.project, { status })
      f.storage.save(worker)
      expect(() => f.runtime.deleteWorker('parent', worker.id)).toThrow('进程清理')
      expect(() => f.runtime.deleteWorker('other-parent', worker.id)).toThrow('does not belong')
      expect(f.storage.workers.get(worker.id)?.archivedAt).toBeUndefined()
    },
  )

  it('refuses a task with unfinished cleanup even if its public status already looks idle', () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    ;(f.runtime as any).tasks.set(worker.id, { worker })
    expect(() => f.runtime.deleteWorker('parent', worker.id)).toThrow('进程清理')
    ;(f.runtime as any).tasks.delete(worker.id)
    f.runtime.blockOnCleanup(new ProcessCleanupUnconfirmedError())
    expect(() => f.runtime.deleteWorker('parent', worker.id)).toThrow('清理')
    expect(f.storage.workers.get(worker.id)?.archivedAt).toBeUndefined()
  })

  it('a failed delete/restore write leaves the published list unchanged', () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    const save = vi.spyOn(f.storage, 'save').mockImplementationOnce(() => {
      throw new Error('Synthetic disk failure')
    })
    expect(() => f.runtime.deleteWorker('parent', worker.id)).toThrow('disk failure')
    expect(f.runtime.snapshot('parent').workers).toHaveLength(1)
    save.mockRestore()
    f.runtime.deleteWorker('parent', worker.id)
    vi.spyOn(f.storage, 'save').mockImplementationOnce(() => {
      throw new Error('Synthetic disk failure')
    })
    expect(() => f.runtime.restoreWorker('parent', worker.id)).toThrow('disk failure')
    expect(f.runtime.snapshot('parent').archivedWorkers).toHaveLength(1)
  })

  it('management Remotes honor cancellation and parent ownership before mutation', async () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    const original = readFileSync(join(f.directory, `${worker.id}.worker.json`), 'utf8')
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.service.renameWorkerTitle('parent', worker.id, 'Cancelled title', controller.signal),
    ).rejects.toThrow()
    await expect(f.service.deleteWorker('parent', worker.id, controller.signal)).rejects.toThrow()
    await expect(f.service.restoreWorker('parent', worker.id, controller.signal)).rejects.toThrow()
    await expect(
      f.service.renameWorkerTitle('other-parent', worker.id, 'Cross title', f.signal),
    ).rejects.toThrow('does not belong')
    await expect(f.service.deleteWorker('other-parent', worker.id, f.signal)).rejects.toThrow(
      'does not belong',
    )
    await expect(f.service.restoreWorker('other-parent', worker.id, f.signal)).rejects.toThrow(
      'does not belong',
    )
    expect(readFileSync(join(f.directory, `${worker.id}.worker.json`), 'utf8')).toBe(original)
  })

  it('does not configure a legacy conversation using the currently displayed account', async () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    f.service.displayedBindings = new Map([['["parent","antigravity"]', 'synthetic-account-a']])
    await expect(
      f.service.configureWorker('parent', worker.id, JSON.stringify(worker.preference), f.signal),
    ).rejects.toThrow('缺少账号记录')
    expect(f.service.querySelection).not.toHaveBeenCalled()
    expect(f.storage.accountBinding(worker.id)).toBeUndefined()
    expect(f.runtime.get('parent', worker.id).preference).toEqual(worker.preference)
  })
})

describe('explicit legacy restart Remote', () => {
  it('revalidates the current own account and creates a fresh Worker preserving original choices and role', async () => {
    const f = fixture(),
      old = storedWorker(f.project, {
        role: { name: 'Synthetic role', summary: 'Synthetic', prompt: 'Synthetic role prompt' },
      })
    f.storage.save(old)
    f.storage.append(old, { kind: 'assistant', text: 'Synthetic old result' })
    const original = readFileSync(join(f.directory, `${old.id}.worker.json`), 'utf8')
    const receipt = JSON.parse(
      await f.service.restartWorker('parent', old.id, 'Synthetic new task', f.signal),
    )
    expect(receipt.workerId).not.toBe(old.id)
    expect(receipt.cli).toBe('antigravity')
    expect(f.service.querySelection).toHaveBeenCalledWith(
      old.preference,
      f.backend,
      DEFAULT_CONFIG,
      f.project,
      f.signal,
      undefined,
    )
    const fresh = f.runtime.get('parent', receipt.workerId)
    expect(fresh).toMatchObject({
      preference: old.preference,
      role: old.role,
      title: old.title,
      agentName: 'agy-1',
    })
    expect(fresh.conversationId).toBeUndefined()
    await vi.waitFor(() => expect(f.calls).toHaveLength(1))
    expect(f.calls[0]!.argv).not.toContain('--conversation')
    expect(f.calls[0]!.argv.some((arg) => arg.includes(old.role!.prompt))).toBe(true)
    f.calls[0]!.finish()
    await vi.waitFor(() => expect(f.runtime.get('parent', receipt.workerId).status).toBe('completed'))
    expect(f.runtime.get('parent', receipt.workerId).conversationId).toBe('synthetic-new-conversation')
    expect(f.storage.accountBinding(receipt.workerId)).toBe('synthetic-account-a')
    expect(f.storage.accountBinding(old.id)).toBeUndefined()
    expect(readFileSync(join(f.directory, `${old.id}.worker.json`), 'utf8')).toBe(original)
    expect(f.storage.history(old.id)).toHaveLength(1)
  })

  it.each([
    'bound',
    'active',
    'deleted',
    'cross-parent',
    'read-only',
    'cancelled',
    'logged-out',
    'invalid-model',
  ] as const)(
    'rejects %s restart without publishing a new Worker or changing legacy history',
    async (cause) => {
      const f = fixture(),
        worker = storedWorker(f.project)
      f.storage.save(worker)
      if (cause === 'bound') f.storage.bindAccount(worker.id, 'synthetic-account-a')
      if (cause === 'active') {
        worker.status = 'running'
        f.storage.save(worker)
      }
      if (cause === 'deleted') f.runtime.deleteWorker('parent', worker.id)
      if (cause === 'read-only') f.policy.mode = 'read-only'
      if (cause === 'logged-out') account.current = undefined
      if (cause === 'invalid-model') {
        worker.preference.model = 'unsupported-model'
        f.storage.save(worker)
      }
      const controller = new AbortController()
      if (cause === 'cancelled') controller.abort()
      await expect(
        f.service.restartWorker(
          cause === 'cross-parent' ? 'other-parent' : 'parent',
          worker.id,
          'Synthetic',
          controller.signal,
        ),
      ).rejects.toThrow()
      expect(f.storage.workers.size).toBe(1)
      expect(f.jobs.start).not.toHaveBeenCalled()
      expect(f.backend.spawn).not.toHaveBeenCalled()
    },
  )

  it('rechecks source deletion after asynchronous model authorization', async () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    f.service.querySelection.mockImplementationOnce(async (preference) => {
      f.runtime.deleteWorker('parent', worker.id)
      return { binding: 'synthetic-account-a', preference }
    })
    await expect(f.service.restartWorker('parent', worker.id, 'Synthetic', f.signal)).rejects.toThrow(
      '已删除',
    )
    expect(f.jobs.start).not.toHaveBeenCalled()
    expect(f.storage.workers.size).toBe(1)
  })

  it.each(['bound', 'cancelled'] as const)(
    'rechecks %s state after asynchronous authorization',
    async (change) => {
      const f = fixture(),
        worker = storedWorker(f.project)
      f.storage.save(worker)
      const controller = new AbortController()
      f.service.querySelection.mockImplementationOnce(async (preference) => {
        if (change === 'bound') f.storage.bindAccount(worker.id, 'synthetic-account-a')
        else controller.abort()
        return { binding: 'synthetic-account-a', preference }
      })
      await expect(
        f.service.restartWorker('parent', worker.id, 'Synthetic', controller.signal),
      ).rejects.toThrow()
      expect(f.jobs.start).not.toHaveBeenCalled()
      expect(f.storage.workers.size).toBe(1)
      expect(f.backend.spawn).not.toHaveBeenCalled()
    },
  )

  it('refuses account changes at queue admission without resuming the old native conversation', async () => {
    const f = fixture(),
      worker = storedWorker(f.project)
    f.storage.save(worker)
    f.jobs.start.mockImplementationOnce((spec) => {
      account.current = 'synthetic-account-b'
      spec.run()
      return 'synthetic-job'
    })
    const receipt = JSON.parse(
      await f.service.restartWorker('parent', worker.id, 'Synthetic new task', f.signal),
    )
    await vi.waitFor(() => expect(f.runtime.get('parent', receipt.workerId).status).toBe('failed'))
    expect(f.runtime.get('parent', receipt.workerId).error).toContain('账号已变更')
    expect(f.storage.accountBinding(worker.id)).toBeUndefined()
    expect(f.storage.accountBinding(receipt.workerId)).toBeUndefined()
    expect(f.runtime.get('parent', worker.id).conversationId).toBe('synthetic-old-conversation')
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })
})
