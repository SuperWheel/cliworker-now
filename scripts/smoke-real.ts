// Opt-in real Antigravity acceptance. It consumes CLI credits and writes only a fixture workspace.
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, discoverModels } from '../src/host/process.ts'
const root = resolve('.test-data/real-smoke'),
  project = join(root, 'workspace')
mkdirSync(project, { recursive: true })
mkdirSync('.test-data/evidence', { recursive: true })
const nonce = `CLIWORKER_${Date.now()}`
writeFileSync(join(project, 'nonce.txt'), nonce)
const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const runtime = new WorkerRuntime(new WorkerStorage(join(root, `state-${Date.now()}`)), ctx.subprocess, {
  ...DEFAULT_CONFIG,
  timeoutMs: 180000,
  graceMs: 1000,
})
const evidence: Record<string, unknown> = {
  started: new Date().toISOString(),
  kind: 'real-antigravity',
  project,
}
try {
  const models = await discoverModels(ctx.subprocess, DEFAULT_CONFIG, project, new AbortController().signal)
  const model = process.env.CLIWORKER_SMOKE_MODEL ?? 'gemini-3.8-flash-low'
  assert(models.some((m) => m.id === model))
  const preference = { model, effort: 'low' as const }
  const first = runtime.submit(
    'smoke-parent',
    project,
    '真实运行验收',
    'Read nonce.txt in the current working directory. Reply with its exact content only. Do not change files or call any other agent.',
    preference,
    'accept-edits',
  )
  const one = await first.done
  assert.equal(one.status, 'completed', one.error)
  assert(one.lastResult?.includes(nonce))
  assert(one.conversationId)
  evidence.first = {
    status: one.status,
    conversationId: one.conversationId,
    workerId: one.id,
    matchedNonce: true,
    events: runtime.storage.history(one.id).length,
  }
  console.log('Real initial run passed')
  const follow = runtime.submit(
    'smoke-parent',
    project,
    one.title,
    'Without calling tools, repeat the nonce from our previous turn exactly.',
    preference,
    'accept-edits',
    one.id,
  )
  const two = await follow.done
  assert.equal(two.status, 'completed', two.error)
  assert(two.lastResult?.includes(nonce))
  evidence.followup = { status: two.status, conversationId: two.conversationId, matchedNonce: true }
  console.log('Real follow-up passed')
  const stop = runtime.submit(
    'smoke-parent',
    project,
    '真实停止验收',
    'Use the terminal to run sleep 45 and then reply finished. Do not change files or call another agent.',
    preference,
    'accept-edits',
  )
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      release()
      reject(new Error('No CLI init before stop deadline'))
    }, 30000)
    const release = runtime.subscribe(() => {
      if (stop.worker.conversationId) {
        clearTimeout(deadline)
        release()
        resolve()
      }
    })
  })
  const stopped = await runtime.stop('smoke-parent', stop.worker.id)
  assert.equal(stopped.status, 'interrupted')
  evidence.stop = { status: stopped.status, cleanupAwaited: true, conversationId: stopped.conversationId }
  assert.equal(readFileSync(join(project, 'nonce.txt'), 'utf8'), nonce)
  evidence.finished = new Date().toISOString()
  evidence.passed = true
  console.log('Real stop passed')
} catch (error) {
  evidence.error = String(error)
  throw error
} finally {
  await runtime.close()
  await ctx.fiber.dispose()
  writeFileSync('.test-data/evidence/real-smoke.json', JSON.stringify(evidence, null, 2))
}
