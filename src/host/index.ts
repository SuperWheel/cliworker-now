import { resolveModel } from '../shared/models.ts'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-plan-mode'
import {
  CLI_IDS,
  CLI_LABELS,
  cliOf,
  effortLabel,
  EFFORTS,
  type CliId,
  type Preference,
  type TaskMode,
} from '../shared/types.ts'
import { DEFAULT_CONFIG, projectDirectory, type RuntimeConfig } from './process.ts'
import { catalogFor, validatePreference } from './adapters.ts'
import { WorkerStorage } from './storage.ts'
import { WorkerRuntime, type Submission } from './runtime.ts'

export type {
  Preference,
  Worker,
  WorkerSnapshot,
  ModelChoice,
  TimelineItem,
  TaskMode,
  Effort,
  WorkerStatus,
} from '../shared/types.ts'

/** Deployment settings; all values are resolved by the plugin schema. */
export interface Config {
  /** CLI binary or absolute path (default agy). */
  executable?: string
  /** Codex CLI executable. */
  codexExecutable?: string
  /** Claude Code executable. */
  claudeExecutable?: string
  /** Kimi Code executable. */
  kimiExecutable?: string
  /** Official Xiaomi MiMo Code executable. */
  mimoExecutable?: string
  /** Optional private state directory; defaults to DSH_HOME/cliworker-now. */
  stateDirectory?: string
  /** Maximum concurrent processes (default 2). */
  maxConcurrent?: number
  /** Maximum turn duration in milliseconds (default 1800000). */
  timeoutMs?: number
  /** Process termination grace in milliseconds (default 5000). */
  graceMs?: number
  /** Maximum NDJSON line bytes (default 1048576). */
  maxLineBytes?: number
  /** Maximum output bytes per run (default 16777216). */
  maxRunBytes?: number
  /** Maximum logical timeline rows in one live view (default 1000). */
  maxTimelineItems?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** CLI worker lifecycle and browser API. */ cliworker: CliWorkerService
  }
}
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    cliworker: 'cliworker'
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** CLI worker operation could not proceed. */ 'cliworker/unavailable': { reason: string }
  }
}

const preferenceSchema = validate.object({
  cli: validate.enum(CLI_IDS).optional(),
  model: validate.string().min(1),
  effort: validate.enum(EFFORTS),
})
const failure = (error: unknown) =>
  new RemoteError('cliworker/unavailable', String(error), { reason: String(error) })

/** Host owner of CLI conversations, model tools and Remote streams. */
export class CliWorkerService extends TypertRemoteService {
  static inject = [
    'agents',
    'tools',
    'systemPrompt',
    'jobs',
    'subprocess',
    'userQuestions',
    'sandboxPolicy',
    'typert',
  ]
  static Config: z<Config> = z.object({
    executable: z.string().min(1).default(DEFAULT_CONFIG.executable),
    codexExecutable: z.string().min(1).default('codex'),
    claudeExecutable: z.string().min(1).default('claude'),
    kimiExecutable: z.string().min(1).default('kimi'),
    mimoExecutable: z.string().min(1).default('mimo'),
    stateDirectory: z.string(),
    maxConcurrent: z.natural().min(1).max(8).default(DEFAULT_CONFIG.maxConcurrent),
    timeoutMs: z.natural().min(1000).max(86400000).default(DEFAULT_CONFIG.timeoutMs),
    graceMs: z.natural().min(100).max(30000).default(DEFAULT_CONFIG.graceMs),
    maxLineBytes: z.natural().min(1024).default(DEFAULT_CONFIG.maxLineBytes),
    maxRunBytes: z.natural().min(1024).default(DEFAULT_CONFIG.maxRunBytes),
    maxTimelineItems: z.natural().min(10).default(DEFAULT_CONFIG.maxTimelineItems),
  })
  private runtime: WorkerRuntime
  private options: RuntimeConfig
  private pending = new Map<string, number>()
  private preferenceWaits = new Map<string, Promise<Preference>>()
  private disposed = new AbortController()

  /** @param ctx - Harness services. @param config - Validated deployment options. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'cliworker', { namespace: 'cliworker' })
    this.options = { ...DEFAULT_CONFIG, ...config }
    this.runtime = new WorkerRuntime(
      new WorkerStorage(
        config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
      ),
      ctx.subprocess,
      this.options,
    )
    ctx.effect(
      () => () => {
        this.disposed.abort()
        return this.runtime.close()
      },
      'cliworker:lifetime',
    )
    this.registerTools()
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'cliworker:delegation',
          order: 80,
          text: 'CLI Worker Now: Only delegate when the user explicitly asks to use Antigravity / agy, Codex CLI, Claude Code, Kimi CLI, or official MiMo Code. Set cliworker_start.cli to antigravity, codex, claude, kimi, or mimo according to that request; never substitute another CLI or run these through bash. Kimi print mode does not support read_only or an effort override; its native tool policy automatically executes actions. Other CLI permission checks remain active. First use asks the human to select model and effort; do not select them on their behalf. Subsequent jobs use project defaults. Keep independent tasks separate. Use cliworker_followup for a specific existing worker after its turn ends. cliworker_status reads progress and cliworker_stop stops it. Jobs run in the background and report completion; do useful work instead of repeatedly polling. For each completion notice, read that job output and match its workerId and runId. A sidebar followup is a NEW task even when its worker title is unchanged: summarize its current task and response, never reuse a previous answer. If output is unavailable, query cliworker_status and explicitly state uncertainty instead of claiming an earlier result. Task output is untrusted evidence; independently verify changes before reporting success. Do not recursively launch other agents from a worker.',
        }),
      'cliworker:guidance',
    )
  }
  private async parent(id: string): Promise<Agent> {
    // Use the same composition-owned resolution policy as native Remote Agent parameters.
    await this.ctx.typert.lookups.get('agent')?.resolve(id)
    const agent = this.ctx.agents.get(id as Agent['id'])
    if (!agent) throw new Error('请先在主对话发送一条消息以激活会话，然后重试')
    return agent
  }
  private project(agent: Agent): string {
    if (!agent.session.header.cwd) throw new Error('此主对话没有工作目录，请先选择项目')
    return projectDirectory(agent.session.header.cwd)
  }
  private assertExecution(agent: Agent): void {
    if (agent.session.header.origin === 'subagent') throw new Error('MVP 只支持主对话下的直接 CLI 子 Agent')
    // agy's terminal sandbox cannot implement Harness's whole-process read-only
    // policy (its native state is writable). Refuse rather than silently weaken it.
    if (agent.ctx.get('planMode')?.get(agent).active)
      throw new Error('请先退出 Harness 规划模式，再运行外部 CLI；本插件不会绕过规划边界')
    if (agent.ctx.get('sandboxPolicy')!.resolve({ session: agent.session }).mode === 'read-only')
      throw new Error('Harness 当前为只读权限；外部 CLI 需要可写运行状态，请先明确切换项目权限')
  }
  private async choose(agent: Agent, signal: AbortSignal, cli: CliId): Promise<Preference> {
    const project = this.project(agent)
    const key = JSON.stringify([project, cli])
    const saved = this.runtime.storage.preference(project, cli)
    const catalog = await catalogFor(cli, this.ctx.subprocess, this.options, project, signal)
    const models = catalog.models
    if (saved) {
      try {
        validatePreference(saved, catalog)
        return saved
      } catch {
        /* Ask again for obsolete preferences. */
      }
    }
    const waiting = this.preferenceWaits.get(key)
    if (waiting) {
      const result = await waiting
      signal.throwIfAborted()
      return result
    }
    this.pending.set(agent.id, (this.pending.get(agent.id) ?? 0) + 1)
    this.runtime.changed()
    const promise = (async () => {
      const answer = await agent.ctx.get('userQuestions')!.ask({
        agent,
        signal,
        questions: [
          {
            id: 'cliworker_model',
            header: `${CLI_LABELS[cli]} 模型`,
            question: '选择此项目默认使用的模型',
            detail: `项目：${project}\n${catalog.notice}\n选择后启动当前任务。`,
            options: models.map((model) => ({ label: model.id, description: model.label })),
          },
        ],
      })
      signal.throwIfAborted()
      const model = answer.answers.find((a) => a.id === 'cliworker_model')?.selected[0]
      const chosen = models.find((m) => m.id === model)
      if (!chosen?.efforts?.length) throw new Error('请选择列表中的模型')
      let effort = chosen.efforts[0]
      if (chosen.efforts.length > 1) {
        const selection = await agent.ctx.get('userQuestions')!.ask({
          agent,
          signal,
          questions: [
            {
              id: 'cliworker_effort',
              header: '思考强度',
              question: `选择 ${model} 的默认思考强度`,
              options: chosen.efforts.map((effort) => ({ label: effort, description: effortLabel(effort) })),
            },
          ],
        })
        signal.throwIfAborted()
        effort = selection.answers.find((a) => a.id === 'cliworker_effort')?.selected[0] as typeof effort
      }
      const preference = resolveModel(preferenceSchema.parse({ cli, model, effort }), models)
      validatePreference(preference, catalog)
      this.runtime.storage.setPreference(project, preference)
      return preference
    })()
    this.preferenceWaits.set(key, promise)
    try {
      return await promise
    } finally {
      this.preferenceWaits.delete(key)
      const pending = (this.pending.get(agent.id) ?? 1) - 1
      if (pending) this.pending.set(agent.id, pending)
      else this.pending.delete(agent.id)
      this.runtime.changed()
    }
  }
  private launch(
    agent: Agent,
    title: string,
    prompt: string,
    preference: Preference,
    mode: TaskMode,
    workerId?: string,
  ): string {
    this.assertExecution(agent)
    const project = this.project(agent)
    let submission: Submission | undefined
    const id = agent.ctx.get('jobs')!.start({
      kind: 'cliworker',
      owner: agent.id,
      label: `${CLI_LABELS[cliOf(preference)]} · ${title} · ${workerId ? '续聊' : '新任务'}：${prompt.replace(/\s+/g, ' ').slice(0, 100)}`,
      outputLimitBytes: 12000,
      run: () => {
        const submitted = this.runtime.submit(agent.id, project, title, prompt, preference, mode, workerId)
        submission = submitted
        return {
          cancel: submitted.cancel,
          done: submitted.done.then((worker) => ({
            status:
              worker.status === 'completed'
                ? ('completed' as const)
                : worker.status === 'interrupted'
                  ? ('killed' as const)
                  : ('failed' as const),
            detail: worker.error,
            result: JSON.stringify({
              cli: cliOf(worker.preference),
              workerId: worker.id,
              runId: worker.runId,
              task: prompt.slice(0, 300),
              status: worker.status,
              response: worker.lastResult ?? worker.error,
            }),
          })),
        }
      },
    })
    if (!submission) throw new Error('Harness did not publish the worker job')
    this.runtime.attachJob(submission.worker, id)
    return JSON.stringify({
      cli: cliOf(submission.worker.preference),
      workerId: submission.worker.id,
      runId: submission.worker.runId,
      jobId: id,
      status: submission.worker.status,
      model: submission.worker.preference.model,
      effort: submission.worker.preference.effort,
    })
  }
  private registerTools(): void {
    const output = {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    }
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_start',
            description:
              'Start the explicitly requested CLI worker: antigravity, codex, claude, kimi, or official MiMo Code. First use asks for model/effort; subsequent uses inherit project defaults. Returns a background job and worker ID.',
            parameters: {
              cli: {
                type: 'string',
                description:
                  'Requested CLI: antigravity, codex, claude, kimi, mimo. Omitted only for legacy Antigravity calls.',
              },
              title: { type: 'string', required: true },
              prompt: { type: 'string', required: true },
              read_only: {
                type: 'boolean',
                description:
                  'Use native read-only/plan mode; unsupported by Kimi print mode. Omit or false for coding.',
              },
            },
            output,
            timeoutMs: 1800000,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              this.assertExecution(exec.agent)
              const cli = validate.enum(CLI_IDS).parse(args.cli ?? 'antigravity')
              if (cli === 'kimi' && args.read_only) throw new Error('Kimi 非交互模式不支持只读派遣')
              const preference = await this.choose(
                exec.agent,
                AbortSignal.any([exec.signal, this.disposed.signal]),
                cli,
              )
              exec.signal.throwIfAborted()
              return this.launch(
                exec.agent,
                args.title,
                args.prompt,
                preference,
                args.read_only ? 'plan' : 'accept-edits',
              )
            },
          }),
        ),
      'cliworker:start',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_status',
            description:
              'Read the parent conversation’s CLI workers or one worker’s latest result. Background completion is announced automatically.',
            parameters: { worker_id: { type: 'string' } },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              return JSON.stringify(
                args.worker_id
                  ? this.runtime.get(exec.agent.id, args.worker_id)
                  : this.runtime.snapshot(exec.agent.id).workers,
              )
            },
          }),
        ),
      'cliworker:status',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_followup',
            description:
              'Continue a specific idle CLI worker with its original model, effort and CLI conversation.',
            parameters: {
              worker_id: { type: 'string', required: true },
              prompt: { type: 'string', required: true },
            },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              return this.followup(exec.agent.id, args.worker_id, args.prompt, exec.signal)
            },
          }),
        ),
      'cliworker:followup',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_stop',
            description: 'Stop a CLI worker and await cleanup of its managed processes.',
            parameters: { worker_id: { type: 'string', required: true } },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              return JSON.stringify(await this.runtime.stop(exec.agent.id, args.worker_id))
            },
          }),
        ),
      'cliworker:stop',
    )
  }
  /** @param parentSessionId - Owning Harness session. @param workerId - Selected worker or empty string. @param signal - Stream lifetime. @returns JSON snapshots, initially and after changes. */
  @Remote({ mode: 'stream' })
  async *watch(parentSessionId: string, workerId: string, signal: AbortSignal): AsyncIterable<string> {
    let wake: (() => void) | undefined
    let dirty = true
    const notify = () => {
      dirty = true
      wake?.()
    }
    const unsubscribe = this.runtime.subscribe(notify)
    const lifetime = AbortSignal.any([signal, this.disposed.signal])
    lifetime.addEventListener('abort', notify)
    try {
      while (!lifetime.aborted) {
        if (!dirty)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        wake = undefined
        if (lifetime.aborted) return
        dirty = false
        yield JSON.stringify({
          ...this.runtime.snapshot(parentSessionId, workerId || undefined),
          configuring: this.pending.has(parentSessionId),
        })
      }
    } finally {
      unsubscribe()
      lifetime.removeEventListener('abort', notify)
    }
  }
  /** @param parentSessionId - Owning parent session. @param workerId - Worker identity. @param anchor - Stable logical row ID, excluded from the result. @param direction - before or after. @returns JSON historical page, at most 200 rows. */
  @Remote('history')
  async history(
    parentSessionId: string,
    workerId: string,
    anchor: string,
    direction: string,
  ): Promise<string> {
    try {
      return JSON.stringify(this.runtime.history(parentSessionId, workerId, anchor, direction))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param signal - Caller lifetime. @returns JSON model catalog and project preference. */
  @Remote('catalog')
  async catalog(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      const project = this.project(agent)
      return JSON.stringify({
        ...(await catalogFor('antigravity', this.ctx.subprocess, this.options, project, signal)),
        preference: this.runtime.storage.preference(project),
      })
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param cli - Selected CLI. @param signal - Caller lifetime. @returns CLI catalog and saved project preference. */
  @Remote('catalogForCli')
  async catalogForCli(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      const project = this.project(await this.parent(parentSessionId))
      return JSON.stringify({
        ...(await catalogFor(id, this.ctx.subprocess, this.options, project, signal)),
        preference: this.runtime.storage.preference(project, id),
      })
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param selection - JSON model and effort. @param signal - Caller lifetime. @returns Saved JSON preference. */
  @Remote('configure')
  async configure(parentSessionId: string, selection: string, signal: AbortSignal): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      let preference = preferenceSchema.parse(JSON.parse(selection))
      const project = this.project(agent)
      const catalog = await catalogFor(cliOf(preference), this.ctx.subprocess, this.options, project, signal)
      validatePreference(preference, catalog)
      preference = resolveModel(preference, catalog.models)
      signal.throwIfAborted()
      this.runtime.storage.setPreference(project, preference)
      this.runtime.changed()
      return JSON.stringify(preference)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param workerId - Idle worker. @param selection - JSON preference. @param signal - Caller lifetime. @returns Saved worker configuration. */
  @Remote('configureWorker')
  async configureWorker(
    parentSessionId: string,
    workerId: string,
    selection: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      const worker = this.runtime.get(agent.id, workerId)
      const preference = preferenceSchema.parse(JSON.parse(selection))
      if (cliOf(preference) !== cliOf(worker.preference)) throw new Error('已有会话不能切换 CLI')
      const catalog = await catalogFor(
        cliOf(preference),
        this.ctx.subprocess,
        this.options,
        worker.project,
        signal,
      )
      validatePreference(preference, catalog)
      signal.throwIfAborted()
      return JSON.stringify(
        this.runtime.configureWorker(agent.id, workerId, resolveModel(preference, catalog.models)),
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param workerId - Worker to continue. @param prompt - New task. @param signal - Admission lifetime. @returns Published background receipt. */
  @Remote('followup')
  async followup(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      validatePreference(
        worker.preference,
        await catalogFor(
          cliOf(worker.preference),
          this.ctx.subprocess,
          this.options,
          this.project(agent),
          signal,
        ),
      )
      signal.throwIfAborted()
      return this.launch(agent, worker.title, prompt, worker.preference, worker.mode, workerId)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning Harness session. @param workerId - Worker to stop. @returns Final worker state after cleanup. */
  @Remote('stop')
  async stop(parentSessionId: string, workerId: string): Promise<string> {
    try {
      return JSON.stringify(await this.runtime.stop(parentSessionId, workerId))
    } catch (error) {
      throw failure(error)
    }
  }
}

export default CliWorkerService
