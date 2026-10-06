// Opt-in REAL adapter acceptance. Requires prior user authorization for this
// exact CLI/model. --help does not start a CLI; --catalog-only sends no prompt.
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { Preference, Worker } from '../src/shared/types.ts'
import type { RuntimeConfig } from '../src/host/process.ts'

const supported = ['pi', 'omp', 'opencode', 'zcode'] as const
type ExtendedCli = (typeof supported)[number]
const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help')) {
  console.log(`Usage: node --import tsx scripts/smoke-extended.ts --cli <${supported.join('|')}> [--catalog-only]
Runs the real WorkerRuntime adapter: catalog, exact marker, same-session follow-up, file artifact, persisted replay.
Only the selected CLI runs. All model selections are GLM-5.3-Flash; low except OpenCode native default.
Entry overrides: CLIWORKER_PI_ENTRY, CLIWORKER_OMP_ENTRY, CLIWORKER_OPENCODE_ENTRY, CLIWORKER_ZCODE_ENTRY.
ZCode also needs its already-authorized CLIWORKER_ZCODE_AUTH_BASE and, if necessary, CLIWORKER_ZCODE_BUILTIN_CONFIG.
Pi/OMP/OpenCode resolve only Harness's ZAI_CODING_CN_API_KEY reference in memory.
Evidence goes to a new private .test-data/extended-smoke/run-* directory.`)
  process.exit(0)
}
const at = args.indexOf('--cli')
const cli = args[at + 1] as ExtendedCli
if (
  at < 0 ||
  !supported.includes(cli) ||
  args.some((arg, index) => !['--cli', '--catalog-only'].includes(arg) && index !== at + 1)
)
  throw new Error('Specify exactly one supported --cli; use --help for usage')
if (args.filter((arg) => arg === '--cli').length !== 1) throw new Error('Run one CLI at a time')
const catalogOnly = args.includes('--catalog-only')
process.umask(0o077)
const parent = resolve('.test-data/extended-smoke')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parent, 'run-')))
const project = join(root, cli, 'workspace')
mkdirSync(project, { recursive: true, mode: 0o700 })
const exec = promisify(execFile)
async function authorizedHarnessCredential(ref: string): Promise<string | undefined> {
  if (ref !== 'ZAI_CODING_CN_API_KEY') throw new Error('Smoke refuses any other credential reference')
  // Harness credentials-local parseRefs/resolve maps refs directly to strings.
  // stdout is captured only in memory; errors are deliberately generic so YAML
  // parser diagnostics cannot quote secret source lines into test output.
  const helper = `from pathlib import Path\nimport sys,yaml\ntry:\n config=yaml.safe_load((Path.home()/'.dsh/profiles/desktop/cordis.patch.yml').read_text())\n matches=[x['config']['providers']['zai-coding-cn'] for x in config if isinstance(x,dict) and 'zai-coding-cn' in x.get('config',{}).get('providers',{})]\n assert len(matches)==1 and matches[0]['apiKeyEnv']=='ZAI_CODING_CN_API_KEY'\n data=yaml.safe_load((Path.home()/'.dsh/.credentials.yaml').read_text())\n value=data['refs']['ZAI_CODING_CN_API_KEY']\n assert isinstance(value,str) and value\nexcept Exception:\n sys.exit(12)\nsys.stdout.write(value)`
  try {
    const { stdout } = await exec('python3', ['-c', helper], { maxBuffer: 65536, timeout: 10000 })
    if (!stdout) throw new Error('empty')
    return stdout
  } catch {
    throw new Error('Cannot resolve the explicitly authorized Harness ZAI_CODING_CN_API_KEY reference')
  }
}
const selectedModels: Record<ExtendedCli, string> = {
  pi: 'zai-coding-cn/glm-5.3-flash',
  omp: 'cliworker-zai-cn/glm-5.3-flash',
  opencode: 'zhipuai-coding-plan/glm-5.3-flash',
  zcode: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash',
}
const preference: Preference = {
  cli,
  model: selectedModels[cli],
  effort: cli === 'opencode' ? 'default' : 'low',
}
// Dynamic imports keep --help from creating a runtime or importing active Host
// services. This script exercises the actual shared dispatch path, not a probe.
const { WorkerRuntime } = await import('../src/host/runtime.ts')
const { WorkerStorage } = await import('../src/host/storage.ts')
const { DEFAULT_CONFIG } = await import('../src/host/process.ts')
const { catalogFor, validatePreference } = await import('../src/host/adapters.ts')
const overrides: Partial<RuntimeConfig> = {}
for (const name of supported) {
  const entry = process.env[`CLIWORKER_${name.toUpperCase()}_ENTRY`]
  if (entry) overrides[`${name}Executable`] = realpathSync(entry)
}
if (cli === 'zcode' && !process.env.CLIWORKER_ZCODE_AUTH_BASE)
  throw new Error('ZCode smoke requires the explicitly authorized native CLI auth profile path')
const config: RuntimeConfig = {
  ...DEFAULT_CONFIG,
  ...overrides,
  stateDirectory: join(root, 'catalog-state'),
  zaiCredentialRef: 'ZAI_CODING_CN_API_KEY',
  resolveCredential: authorizedHarnessCredential,
  zcodeAuthDirectory: process.env.CLIWORKER_ZCODE_AUTH_BASE,
  zcodeBuiltinConfig: process.env.CLIWORKER_ZCODE_BUILTIN_CONFIG,
  timeoutMs: 120000,
  graceMs: 5000,
  maxConcurrent: 1,
}
const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const store = new WorkerStorage(join(root, 'worker-state'))
const runtime = new WorkerRuntime(store, ctx.subprocess, config)
const parentSession = `extended-smoke-${cli}`
const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  cli,
  preference,
  root,
  project,
  stateDirectory: store.directory,
  catalogOnly,
  modelTurns: 0,
  success: false,
}
const receipt = (worker: Worker) => ({
  id: worker.id,
  runId: worker.runId,
  status: worker.status,
  conversationId: worker.conversationId,
  observedModel: worker.observedModel,
  error: worker.error,
})
const assertCompleted = (worker: Worker) => {
  if (worker.status !== 'completed' || !worker.conversationId)
    throw new Error(
      `${cli} adapter did not complete with a native session identity: ${worker.error ?? worker.status}`,
    )
}
let workerId: string | undefined
let expectedConversation: string | undefined
try {
  const catalog = await catalogFor(cli, ctx.subprocess, config, project, new AbortController().signal)
  validatePreference(preference, catalog)
  report.catalog = {
    selected: catalog.models.find((model) => model.id === preference.model),
    modelCount: catalog.models.length,
    notice: catalog.notice,
  }
  console.log(`${cli}: native catalog confirmed`)
  if (!catalogOnly) {
    const marker = `EXTENDED_${cli}_${randomBytes(8).toString('hex')}`
    report.modelTurns = 1
    const first = await runtime.submit(
      parentSession,
      project,
      `${cli} adapter smoke`,
      `Reply exactly ${marker}. Use no tools.`,
      preference,
      'accept-edits',
    ).done
    report.initial = { ...receipt(first), markerMatched: first.lastResult?.trim() === marker }
    assertCompleted(first)
    if (first.lastResult?.trim() !== marker) throw new Error('Initial marker mismatch')
    workerId = first.id
    expectedConversation = first.conversationId
    report.modelTurns = 2
    const resumed = await runtime.submit(
      parentSession,
      project,
      first.title,
      'Repeat only the exact marker from my previous turn. Use no tools.',
      preference,
      'accept-edits',
      first.id,
    ).done
    report.followup = {
      ...receipt(resumed),
      markerMatched: resumed.lastResult?.trim() === marker,
      sameConversation: resumed.conversationId === expectedConversation,
    }
    assertCompleted(resumed)
    if (resumed.conversationId !== expectedConversation || resumed.lastResult?.trim() !== marker)
      throw new Error('Resume identity or marker mismatch')
    const artifactPath = join(project, `${cli}-artifact.json`)
    report.modelTurns = 3
    const written = await runtime.submit(
      parentSession,
      project,
      resumed.title,
      `Use your file-writing tool to create ${artifactPath} with exactly this JSON: ${JSON.stringify({ cli, marker, value: 23 })}. Do not use shell, other agents, or merely describe the file.`,
      preference,
      'accept-edits',
      resumed.id,
    ).done
    assertCompleted(written)
    const bytes = readFileSync(artifactPath)
    const artifact = JSON.parse(bytes.toString('utf8'))
    const matches = artifact.cli === cli && artifact.marker === marker && artifact.value === 23
    const toolConfirmed = store
      .history(written.id)
      .some(
        (event) =>
          event.runId === written.runId &&
          event.kind === 'tool' &&
          ['COMPLETED', 'SUCCESS'].includes(event.state?.toUpperCase() ?? ''),
      )
    report.artifact = {
      ...receipt(written),
      path: artifactPath,
      matches,
      toolConfirmed,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    if (!matches || !toolConfirmed || written.conversationId !== expectedConversation)
      throw new Error('Artifact contents, tool event, or session identity failed verification')
  }
  await runtime.close()
  if (workerId) {
    const reloaded = new WorkerStorage(store.directory)
    const replay = new WorkerRuntime(reloaded, ctx.subprocess, config)
    try {
      const snapshot = replay.snapshot(parentSession, workerId)
      const runs = new Set(
        reloaded
          .history(workerId)
          .filter((event) => event.kind === 'user')
          .map((event) => event.runId),
      )
      const matches =
        snapshot.selected?.status === 'completed' &&
        snapshot.selected.conversationId === expectedConversation &&
        runs.size === 3 &&
        snapshot.timeline.some(
          (item) =>
            item.kind === 'tool' && ['COMPLETED', 'SUCCESS'].includes(item.state?.toUpperCase() ?? ''),
        )
      report.replay = {
        matches,
        runCount: runs.size,
        timelineItems: snapshot.timeline.length,
        conversationId: snapshot.selected?.conversationId,
      }
      if (!matches)
        throw new Error('Persisted WorkerStorage replay did not preserve completed turns and tool history')
    } finally {
      await replay.close()
    }
  }
  report.success = true
} catch (error) {
  report.error = error instanceof Error ? error.message.slice(0, 3000) : 'Extended adapter smoke failed'
  process.exitCode = 1
} finally {
  await runtime.close()
  await ctx.fiber.dispose()
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(
    JSON.stringify({
      cli,
      success: report.success,
      modelTurns: report.modelTurns,
      report: join(root, 'report.json'),
      error: report.error,
    }),
  )
}
