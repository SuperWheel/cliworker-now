// Real CLI stop regression: prove an actual long-running terminal child exits.
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'
const root = resolve(`.test-data/stop-regression-${Date.now()}`)
mkdirSync(root, { recursive: true })
writeFileSync(
  join(root, 'stop-child.mjs'),
  "import {writeFileSync} from 'node:fs';writeFileSync(new URL('./stop-child.pid',import.meta.url),String(process.pid));setTimeout(()=>{},90000)\n",
)
const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const runtime = new WorkerRuntime(new WorkerStorage(join(root, 'state')), ctx.subprocess, {
  ...DEFAULT_CONFIG,
  graceMs: 1000,
  timeoutMs: 120000,
})
let pid: number | undefined
const evidence: Record<string, unknown> = { kind: 'real-antigravity-terminal-stop', root }
try {
  const task = runtime.submit(
    'stop-regression',
    root,
    '真实进程清理回归',
    `Execute this exact terminal command: ${process.execPath} ${join(root, 'stop-child.mjs')}\nThis is an authorized test fixture. Do not modify files or call other agents.`,
    { model: 'gemini-3.8-flash-low', effort: 'low' },
    'accept-edits',
  )
  const deadline = Date.now() + 90000
  while (!existsSync(join(root, 'stop-child.pid')) && Date.now() < deadline) await delay(200)
  assert(existsSync(join(root, 'stop-child.pid')), 'CLI did not launch the terminal fixture')
  pid = Number(readFileSync(join(root, 'stop-child.pid'), 'utf8').trim())
  assert(Number.isSafeInteger(pid) && pid > 1)
  process.kill(pid, 0)
  const worker = await runtime.stop('stop-regression', task.worker.id)
  assert.equal(worker.status, 'interrupted', worker.error)
  assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' })
  Object.assign(evidence, {
    passed: true,
    workerId: worker.id,
    conversationId: worker.conversationId,
    childPid: pid,
    childGone: true,
  })
  console.log('Real terminal child stopped and PID is gone')
} catch (error) {
  evidence.error = String(error)
  throw error
} finally {
  await runtime.close()
  await ctx.fiber.dispose()
  mkdirSync('.test-data/evidence', { recursive: true })
  writeFileSync('.test-data/evidence/real-stop-regression.json', JSON.stringify(evidence, null, 2))
}
