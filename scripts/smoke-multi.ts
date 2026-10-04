// Opt-in: real authenticated CLI calls. Model selection must be approved by the user.
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'
import { catalogFor, validatePreference } from '../src/host/adapters.ts'
import type { Preference } from '../src/shared/types.ts'
const root = resolve('.test-data/multi-smoke'),
  project = join(root, 'workspace')
mkdirSync(project, { recursive: true })
mkdirSync('.test-data/evidence', { recursive: true })
const choices: Preference[] = [
  { cli: 'codex', model: 'gpt-6-luna', effort: 'low' },
  { cli: 'claude', model: 'sonnet', effort: 'low' },
  { cli: 'kimi', model: 'kimi-code/k3-256k', effort: 'default' },
]
if (process.env.CLIWORKER_SMOKE_CLI === 'mimo') {
  if (!process.env.CLIWORKER_SMOKE_MODEL || !process.env.CLIWORKER_SMOKE_EFFORT)
    throw new Error('MiMo smoke requires an explicitly selected model and effort')
  choices.push({
    cli: 'mimo',
    model: process.env.CLIWORKER_SMOKE_MODEL,
    effort: process.env.CLIWORKER_SMOKE_EFFORT as Preference['effort'],
  })
}
const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const runtime = new WorkerRuntime(new WorkerStorage(join(root, `state-${Date.now()}`)), ctx.subprocess, {
  ...DEFAULT_CONFIG,
  timeoutMs: 120000,
  graceMs: 1000,
})
const records: Record<string, any>[] = []
try {
  for (const p of choices.filter(
    (p) => !process.env.CLIWORKER_SMOKE_CLI || p.cli === process.env.CLIWORKER_SMOKE_CLI,
  )) {
    const record: Record<string, unknown> = { cli: p.cli, preference: p }
    records.push(record)
    try {
      validatePreference(
        p,
        await catalogFor(p.cli!, ctx.subprocess, DEFAULT_CONFIG, project, new AbortController().signal),
      )
      const nonce = `MULTI_${p.cli}_${Date.now()}`
      const one = await runtime.submit(
        'multi-smoke',
        project,
        `${p.cli} 实际验收`,
        `Reply exactly ${nonce}. Do not use tools, change files, or invoke other agents.`,
        p,
        'accept-edits',
      ).done
      record.initial = {
        status: one.status,
        conversationId: one.conversationId,
        matched: one.lastResult?.includes(nonce),
        error: one.error,
      }
      console.log(p.cli, 'initial', one.status, one.error ?? '')
      if (one.status !== 'completed' || !one.conversationId || !one.lastResult?.includes(nonce)) continue
      const two = await runtime.submit(
        'multi-smoke',
        project,
        one.title,
        'Repeat the exact marker from our previous turn. No tools or other agents.',
        p,
        'accept-edits',
        one.id,
      ).done
      record.followup = {
        status: two.status,
        sameId: one.conversationId === two.conversationId,
        matched: two.lastResult?.includes(nonce),
        error: two.error,
      }
      console.log(p.cli, 'followup', two.status, two.error ?? '')
    } catch (error) {
      record.error = String(error)
      console.log(p.cli, String(error))
    }
  }
} finally {
  await runtime.close()
  await ctx.fiber.dispose()
  writeFileSync(
    `.test-data/evidence/multi-smoke${process.env.CLIWORKER_SMOKE_CLI ? '-' + process.env.CLIWORKER_SMOKE_CLI : ''}.json`,
    JSON.stringify({ date: new Date().toISOString(), state: runtime.storage.directory, records }, null, 2),
  )
}

if (
  records.some(
    (r) =>
      r.error ||
      !r.initial?.matched ||
      r.initial?.status !== 'completed' ||
      !r.followup?.matched ||
      !r.followup?.sameId ||
      r.followup?.status !== 'completed',
  )
)
  process.exitCode = 1
