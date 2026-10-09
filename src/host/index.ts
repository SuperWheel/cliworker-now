import { resolveModel } from '../shared/models.ts'
import { visibleModelChoices } from '../shared/model-presentation.ts'
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
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-plan-mode'
import {
  CLI_IDS,
  CLI_LABELS,
  cliOf,
  workerName,
  EFFORTS,
  type CliId,
  type Preference,
  type TaskMode,
  type RoleSnapshot,
} from '../shared/types.ts'
import { agentNameSchema, readRoleAnswer, roleQuestion } from './roles.ts'
import {
  DEFAULT_CONFIG,
  projectDirectory,
  ProcessCleanupUnconfirmedError,
  type ProcessBackend,
  type RuntimeConfig,
} from './process.ts'
import { nativeProcessBackend } from './native-process.ts'
import { validatePreference } from './adapters.ts'
import { authorizedCatalog, authorizeSelection } from './authorized-catalog.ts'
import { WorkerStorage, type DispatchSetup } from './storage.ts'
import { WorkerRuntime, type Submission } from './runtime.ts'
import { AccountManager } from './accounts.ts'
import {
  CLI_DELEGATION_GUIDANCE,
  CLI_NAME_GUIDANCE,
  registerCliRouting,
  requireCliName,
  resolveCliName,
} from './routing.ts'

export type {
  Preference,
  Worker,
  WorkerSnapshot,
  ModelChoice,
  TimelineItem,
  TaskMode,
  Effort,
  WorkerStatus,
  RolePreset,
  RoleSnapshot,
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
  zcodeExecutable?: string
  grokExecutable?: string
  ompExecutable?: string
  piExecutable?: string
  hermesExecutable?: string
  hermesHome?: string
  opencodeExecutable?: string
  zcodeAuthDirectory?: string
  zcodeBuiltinConfig?: string
  /** @deprecated Accepted for old deployments only; never read or forwarded. */
  zaiCredentialRef?: string
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

/** Cancel a question/wait independently; late answers cannot commit a selection. */
function waitForInput<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason ?? new Error('选择已取消'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

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
    zcodeExecutable: z.string(),
    grokExecutable: z.string(),
    ompExecutable: z.string(),
    piExecutable: z.string(),
    hermesExecutable: z.string(),
    hermesHome: z.string(),
    opencodeExecutable: z.string(),
    zcodeAuthDirectory: z.string(),
    zcodeBuiltinConfig: z.string(),
    zaiCredentialRef: z.string(),
    stateDirectory: z.string(),
    maxConcurrent: z.natural().min(1).max(8).default(DEFAULT_CONFIG.maxConcurrent),
    timeoutMs: z.natural().min(1000).max(86400000).default(DEFAULT_CONFIG.timeoutMs),
    graceMs: z.natural().min(100).max(30000).default(DEFAULT_CONFIG.graceMs),
    maxLineBytes: z.natural().min(1024).default(DEFAULT_CONFIG.maxLineBytes),
    maxRunBytes: z.natural().min(1024).default(DEFAULT_CONFIG.maxRunBytes),
    maxTimelineItems: z.natural().min(10).default(DEFAULT_CONFIG.maxTimelineItems),
  })
  private runtime: WorkerRuntime
  private accounts: AccountManager
  private accountParents = new Map<string, () => Promise<void>>()
  private options: RuntimeConfig
  private backend: ProcessBackend
  private pending = new Map<string, number>()
  private dispatchWaits = new Map<string, Promise<void>>()
  private selectionBindings = new WeakMap<Preference, string>()
  private selectionProjects = new WeakMap<Preference, string>()
  private displayedBindings = new Map<string, string>()
  private disposed = new AbortController()

  /** @param ctx - Harness services. @param config - Validated deployment options. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'cliworker', { namespace: 'cliworker' })
    this.options = {
      ...DEFAULT_CONFIG,
      ...config,
    }
    this.backend = nativeProcessBackend(ctx.subprocess)
    this.accounts = new AccountManager(this.backend, this.options)
    this.runtime = new WorkerRuntime(
      new WorkerStorage(
        config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
      ),
      this.backend,
      this.options,
    )
    ctx.effect(
      () => () => {
        this.disposed.abort()
        return Promise.all([
          this.runtime.close(),
          this.accounts.close(),
          ...[...this.accountParents.values()].map((dispose) => dispose()),
        ])
      },
      'cliworker:lifetime',
    )
    this.registerTools()
    registerCliRouting(ctx)
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'cliworker:delegation',
          order: 80,
          text: CLI_DELEGATION_GUIDANCE,
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
  private async queryCatalog(...args: Parameters<typeof authorizedCatalog>) {
    try {
      return await authorizedCatalog(...args)
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) this.runtime.blockOnCleanup(error)
      throw error
    }
  }
  private async querySelection(...args: Parameters<typeof authorizeSelection>) {
    try {
      return await authorizeSelection(...args)
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) this.runtime.blockOnCleanup(error)
      throw error
    }
  }
  /** Serialize only this conversation's selection; a cancelled waiter never owns the question. */
  private async chooseDispatch(agent: Agent, callerSignal: AbortSignal, cli: CliId): Promise<DispatchSetup> {
    const signal = AbortSignal.any([callerSignal, this.disposed.signal])
    signal.throwIfAborted()
    this.runtime.assertCliEnabled(cli)
    const project = this.project(agent)
    const key = JSON.stringify([agent.id, project, cli])
    const waits = (this.dispatchWaits ??= new Map())
    const previous = waits.get(key) ?? Promise.resolve()
    let release!: () => void
    const owned = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => owned)
    waits.set(key, tail)
    void tail.then(() => {
      if (waits.get(key) === tail) waits.delete(key)
    })
    this.pending.set(agent.id, (this.pending.get(agent.id) ?? 0) + 1)
    this.runtime.changed()
    try {
      await waitForInput(previous, signal)
      signal.throwIfAborted()
      this.assertExecution(agent)
      this.runtime.assertCliEnabled(cli)
      const { catalog, binding } = await this.queryCatalog(cli, this.backend, this.options, project, signal)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(cli)
      const models = catalog.models
      const valid = (setup: DispatchSetup | undefined): setup is DispatchSetup => {
        if (!setup || setup.binding !== binding || cliOf(setup.preference) !== cli) return false
        try {
          validatePreference(setup.preference, catalog)
          return resolveModel(setup.preference, models).model === setup.preference.model
        } catch {
          return false
        }
      }
      const ask = async (questions: AskUserQuestionItem[]) => {
        signal.throwIfAborted()
        const response = await waitForInput(
          agent.ctx.get('userQuestions')!.ask({ agent, signal, questions }),
          signal,
        )
        signal.throwIfAborted()
        this.runtime.assertCliEnabled(cli)
        return response
      }
      const current = this.runtime.storage.conversationSetup(agent.id, project, cli)
      let setup: DispatchSetup | undefined = valid(current) ? current : undefined
      let selected = false
      if (!current) {
        const saved = this.runtime.storage.dispatchSetup(project, cli)
        if (valid(saved)) {
          const modelLabel =
            models.find(
              (model) =>
                model.id === saved.preference.model ||
                Object.values(model.variants ?? {}).includes(saved.preference.model),
            )?.label ?? saved.preference.model
          const response = await ask([
            {
              id: 'cliworker_reuse',
              header: '沿用设定',
              question: `是否沿用 ${modelLabel} · ${saved.preference.effort} · ${saved.role?.name ?? '不使用角色预设'}？`,
              options: [{ label: '沿用' }, { label: '重新选择' }],
            },
          ])
          const answer = response.answers.find((item) => item.id === 'cliworker_reuse')
          if (
            answer?.custom !== undefined ||
            answer?.selected.length !== 1 ||
            !['沿用', '重新选择'].includes(answer.selected[0]!)
          )
            throw new Error('请选择沿用或重新选择；任务尚未启动')
          if (answer.selected[0] === '沿用') setup = saved
        }
      }
      if (!setup) {
        const choices = visibleModelChoices(models)
        const response = await ask([
          {
            id: 'cliworker_model',
            header: `${CLI_LABELS[cli]} 模型`,
            question: '选择模型',
            options: choices.map((model) => ({ label: model.label })),
          },
        ])
        const answer = response.answers.find((item) => item.id === 'cliworker_model')
        const chosen =
          answer?.custom === undefined && answer?.selected.length === 1
            ? choices.find((model) => model.label === answer.selected[0])
            : undefined
        if (!chosen?.efforts?.length) throw new Error('请选择列表中的模型')
        const offered = structuredClone(this.runtime.storage.rolePresets())
        const questions: AskUserQuestionItem[] = []
        if (chosen.efforts.length > 1)
          questions.push({
            id: 'cliworker_effort',
            header: '思考强度',
            question: `选择 ${chosen.label} 的思考强度`,
            options: chosen.efforts.map((effort) => ({ label: effort })),
          })
        questions.push(roleQuestion(offered))
        const selection = await ask(questions)
        const effortAnswer = selection.answers.find((item) => item.id === 'cliworker_effort')
        const effort =
          chosen.efforts.length === 1
            ? chosen.efforts[0]
            : effortAnswer?.custom === undefined && effortAnswer?.selected.length === 1
              ? effortAnswer.selected[0]
              : undefined
        const preference = resolveModel(preferenceSchema.parse({ cli, model: chosen.id, effort }), models)
        setup = { preference, role: readRoleAnswer(offered, selection) ?? null, binding }
        selected = true
      }
      // A remembered answer is never execution authority. Detect changes during any question.
      const checked = await this.querySelection(
        setup.preference,
        this.backend,
        this.options,
        project,
        signal,
        binding,
      )
      if (checked.preference.model !== setup.preference.model)
        throw new Error('模型与思考强度已变更，请重新选择')
      signal.throwIfAborted()
      this.assertExecution(agent)
      this.runtime.assertCliEnabled(cli)
      if (this.project(agent) !== project) throw new Error('项目已变更，请重新选择')
      if (selected) this.runtime.storage.setDispatchSetup(project, setup)
      if (current !== setup) this.runtime.storage.setConversationSetup(agent.id, project, setup)
      ;(this.selectionBindings ??= new WeakMap()).set(setup.preference, binding)
      ;(this.selectionProjects ??= new WeakMap()).set(setup.preference, project)
      return setup
    } finally {
      release()
      const pending = (this.pending.get(agent.id) ?? 1) - 1
      if (pending) this.pending.set(agent.id, pending)
      else this.pending.delete(agent.id)
      this.runtime.changed()
    }
  }
  private async launch(
    agent: Agent,
    title: string,
    prompt: string,
    preference: Preference,
    mode: TaskMode,
    workerId?: string,
    identity?: { agentName?: string; role?: RoleSnapshot },
    signal: AbortSignal = this.disposed.signal,
  ): Promise<string> {
    this.assertExecution(agent)
    this.runtime.assertCliEnabled(cliOf(preference))
    if (this.accounts.isBusy(cliOf(preference)))
      throw new Error('此 CLI 正在管理账号，请先关闭账号终端再启动任务')
    const project = this.project(agent)
    const selectedProject = this.selectionProjects?.get(preference)
    if (!workerId && selectedProject && selectedProject !== project) throw new Error('项目已变更，请重新选择')
    const expected = workerId
      ? this.runtime.storage.accountBinding(workerId)
      : this.selectionBindings?.get(preference)
    if (workerId && !expected) throw new Error('此历史任务缺少账号记录，请新建任务')
    const { binding, preference: authorizedPreference } = await this.querySelection(
      preference,
      this.backend,
      this.options,
      project,
      signal,
      expected,
    )
    if (authorizedPreference.model !== preference.model) throw new Error('模型与思考强度不匹配，请重新选择')
    signal.throwIfAborted()
    this.assertExecution(agent)
    this.runtime.assertCliEnabled(cliOf(preference))
    if (this.accounts.isBusy(cliOf(preference))) throw new Error('请先关闭账号终端')
    if (this.project(agent) !== project) throw new Error('项目已变更，请重新选择')
    let submission: Submission | undefined
    const id = agent.ctx.get('jobs')!.start({
      kind: 'cliworker',
      owner: agent.id,
      label: `${CLI_LABELS[cliOf(preference)]} · ${title} · ${workerId ? '续聊' : '新任务'}：${prompt.replace(/\s+/g, ' ').slice(0, 100)}`,
      outputLimitBytes: 12000,
      run: () => {
        const submitted = this.runtime.submit(
          agent.id,
          project,
          title,
          prompt,
          preference,
          mode,
          workerId,
          identity,
          binding,
        )
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
              agentName: workerName(worker),
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
      agentName: workerName(submission.worker),
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
            name: 'cliworker_resolve',
            description: `只读解析明确调用中的 CLI 名称、别名或轻微拼写误差，不启动任务、不读取账号、不保存选型。${CLI_NAME_GUIDANCE}。未知、歧义或多个目标返回简短候选错误，不启动、不额外发问题卡。`,
            parameters: {
              name: {
                type: 'string',
                required: true,
                description: '用户要求调用的 CLI 名称；不是任务内容或模型名称。',
              },
            },
            output,
            isConcurrencySafe: () => true,
            execute: async (args) => JSON.stringify(resolveCliName(args.name)),
          }),
        ),
      'cliworker:resolve',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_start',
            description: `用户明确要求“调用 agy cli”或“用 glm cli 完成任务”时，调用本工具打开 CLI Worker 的选型流程。只需提供 CLI、任务标题和任务内容；模型、思考强度与角色由插件收集，完成选型前不会启动任务，不要把它们当作调用本工具的前置输入。${CLI_NAME_GUIDANCE}。Host 仅在首次选择模型、思考强度与角色，或同项目新对话确认是否沿用时提问；同对话后续不重复。不要提前自行提问或增加确认，不代答。返回后台 job、worker ID 和 agentName。已有智能体续聊用 cliworker_followup；歧义返回简短候选错误，不启动、不额外发问题卡。`,
            parameters: {
              cli: {
                type: 'string',
                description: `明确指定的 CLI 规范 ID 或别名：${CLI_NAME_GUIDANCE}。较长名称仅接受唯一轻微误差；短名须精确，不猜模型。仅旧 Antigravity 调用可省略。`,
              },
              title: { type: 'string', required: true },
              prompt: { type: 'string', required: true },
              agent_name: {
                type: 'string',
                description:
                  'Optional user-requested unique worker name within this parent conversation. Otherwise assigned from the selected role. Use followup by worker_name to reuse an existing named worker.',
              },
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
              const cli = requireCliName(args.cli ?? 'antigravity')
              const agentName =
                args.agent_name === undefined ? undefined : agentNameSchema.parse(args.agent_name)
              if (cli === 'kimi' && args.read_only) throw new Error('Kimi 非交互模式不支持只读派遣')
              const setup = await this.chooseDispatch(
                exec.agent,
                AbortSignal.any([exec.signal, this.disposed.signal]),
                cli,
              )
              exec.signal.throwIfAborted()
              return this.launch(
                exec.agent,
                args.title,
                args.prompt,
                setup.preference,
                args.read_only ? 'plan' : 'accept-edits',
                undefined,
                { agentName, role: setup.role ?? undefined },
                AbortSignal.any([exec.signal, this.disposed.signal]),
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
            parameters: { worker_id: { type: 'string' }, worker_name: { type: 'string' } },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              if (args.worker_id || args.worker_name) {
                const worker = this.runtime.resolveWorker(exec.agent.id, args.worker_id, args.worker_name)
                return JSON.stringify({ ...worker, agentName: workerName(worker) })
              }
              return JSON.stringify(
                this.runtime.snapshot(exec.agent.id).workers.map((worker) => ({
                  ...worker,
                  agentName: workerName(worker),
                })),
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
              'Continue a specific idle CLI worker by worker_id or its exact agentName in worker_name. Retains its role, current model/effort and CLI conversation; never starts another worker.',
            parameters: {
              worker_id: { type: 'string' },
              worker_name: { type: 'string' },
              prompt: { type: 'string', required: true },
            },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              const worker = this.runtime.resolveWorker(exec.agent.id, args.worker_id, args.worker_name)
              return this.followup(exec.agent.id, worker.id, args.prompt, exec.signal)
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
            parameters: { worker_id: { type: 'string' }, worker_name: { type: 'string' } },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              const worker = this.runtime.resolveWorker(exec.agent.id, args.worker_id, args.worker_name)
              return JSON.stringify(await this.runtime.stop(exec.agent.id, worker.id))
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
  /** @param parentSessionId - Owning Harness session. @param signal - Query lifetime. @returns Profile-wide CLI enablement JSON. */
  @Remote('cliSettings')
  async cliSettings(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.storage.cliSettings())
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param signal - Query lifetime. @returns JSON role preset library. */
  @Remote('rolePresets')
  async rolePresets(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.storage.rolePresets())
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param requestJSON - Preset fields, optional existing id. @param signal - Mutation lifetime. @returns Saved preset JSON. */
  @Remote('saveRolePreset')
  async saveRolePreset(parentSessionId: string, requestJSON: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      const preset = this.runtime.storage.saveRolePreset(JSON.parse(requestJSON))
      this.runtime.changed()
      return JSON.stringify(preset)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param presetId - Preset to delete. @param signal - Mutation lifetime. @returns Completion. */
  @Remote('deleteRolePreset')
  async deleteRolePreset(parentSessionId: string, presetId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.storage.deleteRolePreset(presetId)
      this.runtime.changed()
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker identity. @param name - Unique readable name. @param signal - Mutation lifetime. @returns Completion. */
  @Remote('renameWorker')
  async renameWorker(
    parentSessionId: string,
    workerId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.renameWorker(parentSessionId, workerId, name)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param enabled - Allow new CLI operations. @param signal - Mutation admission lifetime. @returns Updated profile-wide CLI enablement JSON. */
  @Remote('setCliEnabled')
  async setCliEnabled(
    parentSessionId: string,
    cli: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      const id = validate.enum(CLI_IDS).parse(cli)
      const next = validate.boolean().parse(enabled)
      // The check, persistence, and account startup reservation are synchronous;
      // a pending managed terminal cannot be disabled during its async startup.
      if (!next && this.accounts.isBusy(id))
        throw new Error('此 CLI 正在管理账号，请先关闭账号终端再关闭 CLI')
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.setCliEnabled(id, next))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param signal - Query lifetime. @returns Safe account status JSON. */
  @Remote('accountStatus')
  async accountStatus(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      const project = this.project(await this.parent(parentSessionId))
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(id)
      const status = await this.accounts.status(id, project, signal)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(id)
      return JSON.stringify(status)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param action - Explicit human action. @param signal - Startup lifetime. @returns Managed account terminal identity and instruction JSON. */
  @Remote('accountStart')
  async accountStart(
    parentSessionId: string,
    cli: string,
    action: string,
    signal: AbortSignal,
  ): Promise<string> {
    return this.startAccount(parentSessionId, cli, action, signal)
  }

  /** @param source - One current CLI-native source, never a filesystem path. */
  @Remote('accountStartForSource')
  async accountStartForSource(
    parentSessionId: string,
    cli: string,
    action: string,
    source: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const selected = validate.enum(['native', 'plugin']).parse(source)
      return this.startAccount(parentSessionId, cli, action, signal, selected)
    } catch (error) {
      throw failure(error)
    }
  }

  private async startAccount(
    parentSessionId: string,
    cli: string,
    action: string,
    signal: AbortSignal,
    source?: 'native' | 'plugin',
  ): Promise<string> {
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      const operation = validate.enum(['login', 'logout', 'manage']).parse(action)
      const parent = await this.parent(parentSessionId)
      this.assertExecution(parent)
      this.runtime.assertCliEnabled(id)
      this.runtime.assertAccountIdle(id)
      if (!this.accountParents.has(parent.id)) {
        const dispose = parent.ctx.effect(
          () => () => {
            this.accountParents.delete(parent.id)
            return this.accounts.closeParent(parent.id)
          },
          'cliworker:account-parent',
        )
        this.accountParents.set(parent.id, dispose)
      }
      return JSON.stringify(
        await this.accounts.start(parent.id, id, operation, this.project(parent), signal, source),
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @param signal - Stream lifetime. @returns Ephemeral terminal frame JSON. */
  @Remote({ mode: 'stream' })
  async *accountWatch(
    parentSessionId: string,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    try {
      await this.parent(parentSessionId)
      for await (const frame of this.accounts.watch(parentSessionId, accountId, signal))
        yield JSON.stringify(frame)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @param data - Human keyboard input. @returns Input accepted. */
  @Remote('accountWrite')
  async accountWrite(parentSessionId: string, accountId: string, data: string): Promise<boolean> {
    try {
      this.assertExecution(await this.parent(parentSessionId))
      await this.accounts.write(parentSessionId, accountId, data)
      return true
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @param cols - Visible columns. @param rows - Visible rows. @returns Resize accepted. */
  @Remote('accountResize')
  async accountResize(
    parentSessionId: string,
    accountId: string,
    cols: number,
    rows: number,
  ): Promise<boolean> {
    try {
      await this.parent(parentSessionId)
      await this.accounts.resize(parentSessionId, accountId, cols, rows)
      return true
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @returns Process cleanup completed. */
  @Remote('accountStop')
  async accountStop(parentSessionId: string, accountId: string): Promise<boolean> {
    try {
      await this.accounts.stop(parentSessionId, accountId)
      return true
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param signal - Caller lifetime. @returns JSON model catalog and project preference. */
  @Remote('catalog')
  async catalog(parentSessionId: string, signal: AbortSignal): Promise<string> {
    return this.catalogForCli(parentSessionId, 'antigravity', signal)
  }
  /** @param parentSessionId - Parent session identity. @param cli - Selected CLI. @param signal - Caller lifetime. @returns CLI catalog and saved project preference. */
  @Remote('catalogForCli')
  async catalogForCli(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      const project = this.project(await this.parent(parentSessionId))
      this.runtime.assertCliEnabled(id)
      const { catalog, binding } = await this.queryCatalog(id, this.backend, this.options, project, signal)
      ;(this.displayedBindings ??= new Map()).set(JSON.stringify([parentSessionId, id]), binding)
      this.runtime.assertCliEnabled(id)
      return JSON.stringify({
        ...catalog,
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
      let preference: Preference = preferenceSchema.parse(JSON.parse(selection))
      const project = this.project(agent)
      this.runtime.assertCliEnabled(cliOf(preference))
      const { catalog } = await this.querySelection(
        preference,
        this.backend,
        this.options,
        project,
        signal,
        this.displayedBindings?.get(JSON.stringify([parentSessionId, cliOf(preference)])),
      )
      validatePreference(preference, catalog)
      preference = resolveModel(preference, catalog.models)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(cliOf(preference))
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
      this.runtime.assertCliEnabled(cliOf(preference))
      const { catalog } = await this.querySelection(
        preference,
        this.backend,
        this.options,
        worker.project,
        signal,
        this.runtime.storage.accountBinding(workerId) ??
          this.displayedBindings?.get(JSON.stringify([parentSessionId, cliOf(preference)])),
      )
      validatePreference(preference, catalog)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(cliOf(preference))
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
      this.runtime.assertCliEnabled(cliOf(worker.preference))
      return this.launch(
        agent,
        worker.title,
        prompt,
        worker.preference,
        worker.mode,
        workerId,
        undefined,
        signal,
      )
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
