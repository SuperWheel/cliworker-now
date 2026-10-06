import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import type { Worker } from '../src/shared/types.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it('allows reading retired Harness history but rejects start, resume, reconfigure and enabling before any process', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-retired-runtime-')))
  cleanup.push(() => rmSync(project, { recursive: true, force: true }))
  const storage = new WorkerStorage(join(project, 'state'))
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => '/synthetic/no-cli'),
    spawn: vi.fn(() => {
      throw new Error('Synthetic backend must never start')
    }),
  }
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanup.push(() => runtime.close())
  const worker: Worker = {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: 'synthetic-parent',
    project,
    title: 'Synthetic historical worker',
    preference: { cli: 'harness', model: 'legacy-native-model', effort: 'low' },
    conversationId: 'original-native-session',
    mode: 'accept-edits',
    status: 'completed',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
  }
  storage.save(worker)
  storage.append(worker, { kind: 'assistant', text: 'Synthetic original answer' })
  const before = structuredClone(worker)
  expect(runtime.snapshot(worker.parentSessionId, worker.id).timeline[0]?.text).toBe(
    'Synthetic original answer',
  )
  expect(() =>
    runtime.submit(
      worker.parentSessionId,
      project,
      'test',
      'must not run',
      worker.preference,
      'accept-edits',
    ),
  ).toThrow('入口已移除')
  expect(() =>
    runtime.submit(
      worker.parentSessionId,
      project,
      'test',
      'must not run',
      { cli: 'hermes', model: 'new-native-model', effort: 'default' },
      'accept-edits',
      worker.id,
    ),
  ).toThrow('入口已移除')
  expect(() => runtime.configureWorker(worker.parentSessionId, worker.id, worker.preference)).toThrow(
    '入口已移除',
  )
  expect(() =>
    runtime.configureWorker(worker.parentSessionId, worker.id, {
      cli: 'hermes',
      model: 'new-native-model',
      effort: 'default',
    }),
  ).toThrow('入口已移除')
  expect(() => runtime.setCliEnabled('harness', true)).toThrow('入口已移除')
  expect(storage.workers.get(worker.id)).toEqual(before)
  expect(storage.history(worker.id)).toHaveLength(1)
  expect(backend.spawn).not.toHaveBeenCalled()
  expect(backend.resolveExecutable).not.toHaveBeenCalled()
})
