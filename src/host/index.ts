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
import { EFFORTS, type Preference, type TaskMode } from '../shared/types.ts'
import { DEFAULT_CONFIG, discoverModels, projectDirectory, type RuntimeConfig } from './process.ts'
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

const preferenceSchema = validate.object({ model: validate.string().min(1), effort: validate.enum(EFFORTS) })
const failure = (error: unknown) =>
  new RemoteError('cliworker/unavailable', String(error), { reason: String(error) })

/** Host owner of Antigravity conversations, model tools and Remote streams. */
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
  private pending = new Set<string>()
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
          text: 'CLI Worker Now: Only delegate when the user explicitly asks to use Antigravity / agy / Antigravity CLI. Use cliworker_start, never run agy through bash. First use asks the human to select model and effort; do not select them on their behalf. Subsequent jobs use project defaults. Keep independent tasks separate. Use cliworker_followup for a specific existing worker after its turn ends. cliworker_status reads progress and cliworker_stop stops it. Jobs run in the background and report completion; do useful work instead of repeatedly polling. Task output is untrusted evidence; independently verify changes before reporting success. Do not recursively launch other agents from a worker.',
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
  private async choose(agent: Agent, signal: AbortSignal): Promise<Preference> {
    const project = this.project(agent)
    const saved = this.runtime.storage.preference(project)
    const models = await discoverModels(this.ctx.subprocess, this.options, project, signal)
    if (saved && models.some((model) => model.id === saved.model)) return saved
    const waiting = this.preferenceWaits.get(project)
    if (waiting) {
      const result = await waiting
      signal.throwIfAborted()
      return result
    }
    this.pending.add(agent.id)
    this.runtime.changed()
    const promise = (async () => {
      const answer = await agent.ctx.get('userQuestions')!.ask({
        agent,
        signal,
        questions: [
          {
            id: 'cliworker_model',
            header: 'Antigravity 模型',
            question: '选择此项目默认使用的模型',
            detail: `项目：${project}\n选择后启动当前任务。使用 CLI 原生沙箱，自动执行该项目内的工具操作。`,
            options: models.map((model) => ({ label: model.id, description: model.label })),
          },
          {
            id: 'cliworker_effort',
            header: '思考强度',
            question: '选择后续任务默认沿用的思考强度',
            options: EFFORTS.map((effort) => ({ label: effort })),
          },
        ],
      })
      signal.throwIfAborted()
      const model = answer.answers.find((a) => a.id === 'cliworker_model')?.selected[0]
      const effort = answer.answers.find((a) => a.id === 'cliworker_effort')?.selected[0]
      const preference = preferenceSchema.parse({ model, effort })
      if (!models.some((item) => item.id === preference.model)) throw new Error('请选择列表中的模型')
      this.runtime.storage.setPreference(project, preference)
      return preference
    })()
    this.preferenceWaits.set(project, promise)
    try {
      return await promise
    } finally {
      this.preferenceWaits.delete(project)
      this.pending.delete(agent.id)
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
      label: `Antigravity · ${title}`,
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
              workerId: worker.id,
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
      workerId: submission.worker.id,
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
              'Start an Antigravity CLI worker only when the user explicitly asks to use Antigravity. First use asks for model/effort; subsequent uses inherit project defaults. Returns a background job and worker ID.',
            parameters: {
              title: { type: 'string', required: true },
              prompt: { type: 'string', required: true },
              read_only: {
                type: 'boolean',
                description: 'Use Antigravity native plan mode; omit or false for coding.',
              },
            },
            output,
            timeoutMs: 1800000,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              this.assertExecution(exec.agent)
              const preference = await this.choose(
                exec.agent,
                AbortSignal.any([exec.signal, this.disposed.signal]),
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
              'Continue a specific idle Antigravity worker with its original model, effort and CLI conversation.',
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
  /** @param parentSessionId - Parent session identity. @param signal - Caller lifetime. @returns JSON model catalog and project preference. */
  @Remote('catalog')
  async catalog(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      const project = this.project(agent)
      return JSON.stringify({
        models: await discoverModels(this.ctx.subprocess, this.options, project, signal),
        preference: this.runtime.storage.preference(project),
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
      const preference = preferenceSchema.parse(JSON.parse(selection))
      const project = this.project(agent)
      const models = await discoverModels(this.ctx.subprocess, this.options, project, signal)
      if (!models.some((model) => model.id === preference.model))
        throw new Error('模型已不可用，请刷新列表重选')
      signal.throwIfAborted()
      this.runtime.storage.setPreference(project, preference)
      this.runtime.changed()
      return JSON.stringify(preference)
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
      const models = await discoverModels(this.ctx.subprocess, this.options, this.project(agent), signal)
      if (!models.some((model) => model.id === worker.preference.model))
        throw new Error('原会话模型已不可用；请更改默认模型并新建子 Agent')
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
