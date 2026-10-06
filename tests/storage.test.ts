import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import { CLI_IDS, type Worker } from '../src/shared/types.ts'

// Explicitly synthetic persisted legacy state; no user accounts or logs are read.
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(status: Worker['status'] = 'completed') {
  const dir = mkdtempSync(join(tmpdir(), 'cwn-legacy-storage-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const worker: Worker = {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: 'fixture-parent',
    project: dir,
    title: 'Synthetic historical Harness worker',
    preference: { cli: 'harness', model: '["fixture-provider","fixture-model"]', effort: 'low' },
    conversationId: 'original-harness-session',
    mode: 'accept-edits',
    status,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
  }
  const workerPath = join(dir, `${worker.id}.worker.json`)
  const eventPath = join(dir, `${worker.id}.events.jsonl`)
  writeFileSync(workerPath, JSON.stringify(worker))
  writeFileSync(
    eventPath,
    JSON.stringify({
      seq: 1,
      runId: worker.runId,
      time: worker.updatedAt,
      kind: 'assistant',
      text: 'Synthetic original answer',
    }) + '\n',
  )
  const settings = JSON.stringify({ enabled: { harness: false, codex: false } })
  writeFileSync(join(dir, 'cli-settings.json'), settings)
  const key = createHash('sha256')
    .update(JSON.stringify([dir, 'harness']))
    .digest('hex')
  const preferencePath = join(dir, `${key}.preference.json`)
  writeFileSync(preferencePath, JSON.stringify(worker.preference))
  return { dir, worker, workerPath, eventPath, preferencePath, settings }
}

describe('Hermes migration preserves retired Harness history', () => {
  it('loads legacy settings and history unchanged while giving Hermes independent defaults', () => {
    const f = fixture()
    const original = [f.workerPath, f.eventPath, f.preferencePath].map((p) => readFileSync(p, 'utf8'))
    const store = new WorkerStorage(f.dir)
    cleanup.push(() => store.close())
    expect(CLI_IDS).toContain('hermes')
    expect(CLI_IDS).not.toContain('harness')
    expect(store.cliSettings().enabled.hermes).toBe(true)
    expect(store.cliSettings().enabled.codex).toBe(false)
    expect(store.cliSettings().enabled).not.toHaveProperty('harness')
    expect(store.workers.get(f.worker.id)).toEqual(f.worker)
    expect(store.history(f.worker.id)[0]?.text).toBe('Synthetic original answer')
    expect(store.preference(f.dir, 'hermes')).toBeUndefined()
    expect(store.preference(f.dir, 'harness')).toBeUndefined()
    expect(() => store.setPreference(f.dir, f.worker.preference)).toThrow('入口已移除')
    expect(() => store.setCliEnabled('harness', true)).toThrow('入口已移除')
    expect([f.workerPath, f.eventPath, f.preferencePath].map((p) => readFileSync(p, 'utf8'))).toEqual(
      original,
    )
    expect(readFileSync(join(f.dir, 'cli-settings.json'), 'utf8')).toBe(f.settings)
    store.setPreference(f.dir, { cli: 'hermes', model: 'native-fixture-model', effort: 'default' })
    store.setCliEnabled('hermes', false)
    expect(store.preference(f.dir, 'hermes')?.model).toBe('native-fixture-model')
    expect(readFileSync(f.preferencePath, 'utf8')).toBe(original[2])
    expect(JSON.parse(readFileSync(join(f.dir, 'cli-settings.json'), 'utf8')).enabled).not.toHaveProperty(
      'harness',
    )
  })
  it('marks unfinished legacy work interrupted without suggesting it can resume as Hermes', () => {
    const f = fixture('running')
    const store = new WorkerStorage(f.dir)
    cleanup.push(() => store.close())
    expect(store.workers.get(f.worker.id)).toMatchObject({
      status: 'interrupted',
      conversationId: f.worker.conversationId,
      preference: f.worker.preference,
    })
    expect(store.workers.get(f.worker.id)?.error).toContain('历史记录仅供查看')
    expect(store.history(f.worker.id)).toHaveLength(2)
    expect(store.history(f.worker.id)[1]?.state).toBe('interrupted')
  })
})
