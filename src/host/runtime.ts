import { extendedLaunch, isExtendedCli } from './extended-adapters.ts'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  active,
  CLI_LABELS,
  CLI_SHORT_NAMES,
  LEGACY_ACCOUNT_RECORD_NOTICE,
  isRetiredCli,
  RETIRED_HARNESS_NOTICE,
  cliOf,
  workerName,
  foldEvents,
  type Preference,
  type TaskMode,
  type Worker,
  type WorkerSnapshot,
  type HistoryPage,
  type TimelineItem,
  type CliId,
  type RoleSnapshot,
} from '../shared/types.ts'
import {
  agentNameSchema,
  availableAgentName,
  promptForWorker,
  roleSnapshotSchema,
  workerTitleSchema,
} from './roles.ts'
import { protocolFor, resolveCliExecutable, workerArguments, captureCatalogMetadata } from './adapters.ts'
import { spawnManagedAgent } from './managed-agent.ts'
import {
  projectDirectory,
  ProcessCleanupUnconfirmedError,
  type ProcessBackend,
  type RuntimeConfig,
} from './process.ts'
import { join } from 'node:path'
import { AgyContextReader } from './agy-context.ts'
import { attachTelemetry, TelemetryReader } from './telemetry.ts'
import { WorkerStorage } from './storage.ts'
import { authorizeSelection, ACCOUNT_CHANGED } from './authorized-catalog.ts'
import { readCliAccountBinding } from './cli-account-binding.ts'
import { assertFirstPartyConfiguration, firstPartyEnvironment } from './first-party-models.ts'

interface Task {
  worker: Worker
  prompt: string
  controller: AbortController
  done: Promise<Worker>
  settle: (worker: Worker) => void
  admission: Promise<string>
}
export interface Submission {
  worker: Worker
  done: Promise<Worker>
  cancel: () => void
}

export class WorkerRuntime {
  private agyContextReader = new AgyContextReader()
  private telemetryReader = new TelemetryReader()
  private tasks = new Map<string, Task>()
  private queue: Task[] = []
  private running = new Set<Task>()
  private listeners = new Set<() => void>()
  private disposed = false
  private blocked?: string
  revision = 0
  constructor(
    readonly storage: WorkerStorage,
    private backend: ProcessBackend,
    readonly config: RuntimeConfig,
  ) {
    const cleanup = storage.cleanupBlockState()
    if (cleanup !== 'none')
      this.blocked =
        cleanup === 'invalid'
          ? '进程清理隔离记录无法核验，已暂停任务和账号操作'
          : '无法确认 CLI 进程已清理，已暂停后续派遣，请先核查进程退出状态'
  }
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  changed(): void {
    this.revision++
    for (const callback of this.listeners) callback()
  }
  assertCliEnabled(cli: CliId): void {
    if (this.disposed) throw new Error('插件正在关闭')
    if (this.blocked) throw new Error(this.blocked)
    if (isRetiredCli(cli)) throw new Error(RETIRED_HARNESS_NOTICE)
    if (!this.storage.cliSettings().enabled[cli])
      throw new Error(`${CLI_LABELS[cli]} 已关闭，请先在 CLI Worker 设置中开启`)
  }
  blockOnCleanup(error: ProcessCleanupUnconfirmedError): void {
    this.markCleanupBlocked(error)
    this.drain()
  }
  private markCleanupBlocked(error: unknown): void {
    this.blocked = `无法确认 CLI 进程已清理，已暂停后续派遣：${error instanceof Error ? error.message : String(error)}`
    try {
      // The private marker contains no CLI output, paths, identities or credentials.
      this.storage.blockCleanup()
    } catch {
      // Keep this Host closed even when its storage cannot record the quarantine.
      this.blocked += '；清理隔离记录保存失败'
    }
  }
  setCliEnabled(cli: CliId, enabled: boolean) {
    if (isRetiredCli(cli)) throw new Error(RETIRED_HARNESS_NOTICE)
    if (this.disposed) throw new Error('插件正在关闭')
    if (!enabled) this.assertAccountIdle(cli)
    const settings = this.storage.setCliEnabled(cli, enabled)
    this.changed()
    return settings
  }
  /** Account mutation must also respect a prior unconfirmed process cleanup. */
  assertAccountIdle(cli: string): void {
    if (this.disposed) throw new Error('插件正在关闭')
    if (this.blocked) throw new Error(this.blocked)
    if (
      [...this.storage.workers.values()].some(
        (worker) => active(worker.status) && cliOf(worker.preference) === cli,
      )
    )
      throw new Error('此 CLI 还有运行或排队中的任务，请等待结束后再修改此 CLI 设置或管理账号')
  }
  get(parent: string, id: string): Worker {
    const worker = this.storage.workers.get(id)
    if (!worker || worker.parentSessionId !== parent)
      throw new Error('Worker does not belong to this conversation')
    if (worker.archivedAt) throw new Error('此任务已删除，请先恢复')
    return worker
  }
  /** Exact names are scoped to the owning parent; never select a partial or cross-session match. */
  resolveWorker(parent: string, id?: string, name?: string): Worker {
    if (!id && !name) throw new Error('请指定 worker_id 或 worker_name')
    const normalized = name === undefined ? undefined : agentNameSchema.parse(name)
    if (id) {
      const worker = this.get(parent, id)
      if (normalized && !this.matchesName(worker, normalized))
        throw new Error('worker_id 与 worker_name 不匹配')
      return worker
    }
    const matches = [...this.storage.workers.values()].filter(
      (worker) =>
        worker.parentSessionId === parent && !worker.archivedAt && this.matchesName(worker, normalized!),
    )
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? '智能体名称不唯一，请使用 worker_id'
          : '当前对话中没有此名称的智能体，请检查名称或使用 worker_id',
      )
    return matches[0]!
  }
  private matchesName(worker: Worker, name: string): boolean {
    return workerName(worker) === name || (worker.nameAliases ?? []).includes(name)
  }
  private checkAgentName(parent: string, name: string, excludingId?: string): string {
    const clean = agentNameSchema.parse(name)
    if (
      [...this.storage.workers.values()].some(
        (worker) =>
          worker.parentSessionId === parent &&
          worker.id !== excludingId &&
          [workerName(worker), ...(worker.nameAliases ?? [])].some(
            (name) => name.toLocaleLowerCase() === clean.toLocaleLowerCase(),
          ),
      )
    )
      throw new Error('当前对话已有同名智能体，请换一个名称或续用已有智能体')
    return clean
  }
  renameWorker(parent: string, id: string, name: string): void {
    if (this.disposed) throw new Error('CLI Worker is shutting down')
    const worker = this.get(parent, id)
    const agentName = this.checkAgentName(parent, name, id)
    // Publish the new name only after persistence succeeds. Keep a running task's
    // shared worker reference in sync so its next process event cannot revert it.
    this.storage.save({ ...worker, agentName, agentNameOrigin: 'custom' })
    worker.agentName = agentName
    worker.agentNameOrigin = 'custom'
    this.storage.workers.set(id, worker)
    this.changed()
  }
  renameWorkerTitle(parent: string, id: string, title: string): void {
    if (this.disposed) throw new Error('CLI Worker is shutting down')
    const worker = this.get(parent, id)
    const clean = workerTitleSchema.parse(title)
    this.storage.save({ ...worker, title: clean })
    worker.title = clean
    this.storage.workers.set(id, worker)
    this.changed()
  }
  /** Management cannot hide an in-flight task or a process whose cleanup is unresolved. */
  private assertManagedIdle(worker: Worker): void {
    if (this.disposed) throw new Error('CLI Worker is shutting down')
    if (this.blocked) throw new Error(this.blocked)
    if (active(worker.status) || this.tasks.has(worker.id))
      throw new Error('请等待任务结束并完成进程清理后再管理此任务')
  }
  assertLegacyRestart(parent: string, id: string): Worker {
    const worker = this.get(parent, id)
    this.assertManagedIdle(worker)
    this.assertCliEnabled(cliOf(worker.preference))
    if (!worker.conversationId || this.storage.accountBinding(id))
      throw new Error('只有缺少账号记录的历史任务可通过此操作新建对话')
    return worker
  }
  deleteWorker(parent: string, id: string): void {
    const worker = this.get(parent, id)
    this.assertManagedIdle(worker)
    this.storage.save({ ...worker, archivedAt: new Date().toISOString() })
    this.changed()
  }
  restoreWorker(parent: string, id: string): void {
    const worker = this.storage.workers.get(id)
    if (!worker || worker.parentSessionId !== parent)
      throw new Error('Worker does not belong to this conversation')
    this.assertManagedIdle(worker)
    if (!worker.archivedAt) throw new Error('此任务尚未删除')
    const restored = { ...worker }
    delete restored.archivedAt
    this.storage.save(restored)
    this.changed()
  }
  snapshot(parent: string, selected?: string): WorkerSnapshot {
    const owned = [...this.storage.workers.values()]
      .filter((w) => w.parentSessionId === parent)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const workers = owned.filter((worker) => !worker.archivedAt)
    const archivedWorkers = owned.filter((worker) => !!worker.archivedAt)
    const selectedWorker = selected ? this.storage.workers.get(selected) : undefined
    if (selected && (!selectedWorker || selectedWorker.parentSessionId !== parent))
      throw new Error('Worker does not belong to this conversation')
    const worker = selectedWorker?.archivedAt ? undefined : selectedWorker
    const timeline = worker ? this.timeline(worker) : []
    const telemetry = worker ? this.runTelemetry(worker, worker.runId) : undefined
    const context =
      worker && cliOf(worker.preference) === 'antigravity'
        ? this.agyContextReader.read(worker.conversationId)
        : undefined
    return {
      telemetry:
        telemetry || context
          ? {
              usage: telemetry?.usage,
              contextUsed: telemetry?.contextUsed,
              contextCapacity: telemetry?.contextCapacity,
              ...context,
            }
          : undefined,
      workers,
      archivedWorkers,
      selected: worker,
      resumeBlockedReason:
        worker?.conversationId && !this.storage.accountBinding(worker.id)
          ? LEGACY_ACCOUNT_RECORD_NOTICE
          : undefined,
      timeline: timeline.slice(-this.config.maxTimelineItems),
      revision: this.revision,
      truncated: timeline.length > this.config.maxTimelineItems,
    }
  }
  private timeline(worker: Worker): TimelineItem[] {
    const rows = foldEvents(
      this.storage.history(worker.id),
      active(worker.status) ? undefined : { runId: worker.runId, status: worker.status },
    )
    for (const runId of new Set(rows.map((row) => row.id.split(':')[0]!)))
      attachTelemetry(rows, runId, this.runTelemetry(worker, runId))
    return rows
  }
  private runTelemetry(worker: Worker, runId: string) {
    return this.telemetryReader.read(
      join(this.storage.directory, `${worker.id}.${runId}.raw.jsonl`),
      cliOf(worker.preference),
    )
  }
  history(parent: string, workerId: string, anchor: string, direction: string): HistoryPage {
    const worker = this.get(parent, workerId)
    if (direction !== 'before' && direction !== 'after') throw new Error('Invalid history direction')
    if (!anchor || anchor.length > 256) throw new Error('缺少有效的历史记录位置，请返回实时记录')
    const timeline = this.timeline(worker)
    const index = timeline.findIndex((item) => item.id === anchor)
    if (index < 0) throw new Error('历史记录位置已不可用，请返回实时记录后重试')
    // Row identity remains stable when later events append or a streamed step grows.
    const end = direction === 'before' ? index : Math.min(timeline.length, index + 201)
    const start = direction === 'before' ? Math.max(0, end - 200) : index + 1
    return {
      workerId,
      items: timeline.slice(start, end),
      start,
      end,
      total: timeline.length,
      hasOlder: start > 0,
      hasNewer: end < timeline.length,
    }
  }
  configureWorker(parent: string, id: string, preference: Preference): Worker {
    if (this.disposed) throw new Error('CLI Worker is shutting down')
    const worker = this.get(parent, id)
    if (isRetiredCli(cliOf(worker.preference))) throw new Error(RETIRED_HARNESS_NOTICE)
    if (active(worker.status)) throw new Error('请等待本轮结束后再修改模型与强度')
    if (cliOf(worker.preference) !== cliOf(preference)) throw new Error('已有会话不能切换 CLI')
    this.assertCliEnabled(cliOf(preference))
    const updated = { ...worker, preference: { ...preference } }
    this.storage.save(updated)
    this.changed()
    return updated
  }
  submit(
    parent: string,
    project: string,
    title: string,
    prompt: string,
    preference: Preference,
    mode: TaskMode,
    previousId?: string,
    identity?: { agentName?: string; role?: RoleSnapshot },
    authorizedBinding?: string,
  ): Submission {
    if (this.disposed) throw new Error('CLI Worker is shutting down')
    if (this.blocked) throw new Error(this.blocked)
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('Task must contain 1–100000 characters')
    const canonical = projectDirectory(project)
    const previous = previousId ? this.get(parent, previousId) : undefined
    const effective = previous?.preference ?? preference
    this.assertCliEnabled(cliOf(effective))
    if (previous && active(previous.status))
      throw new Error('This CLI conversation already has a running or queued turn')
    if (previous && !previous.conversationId)
      throw new Error('No CLI conversation_id was received; start a new worker')
    if (previous && !this.storage.accountBinding(previous.id)) throw new Error(LEGACY_ACCOUNT_RECORD_NOTICE)
    if (previous && previous.project !== canonical)
      throw new Error('Cannot resume a worker in another workspace')
    if (cliOf(effective) === 'kimi' && (previous?.mode ?? mode) === 'plan')
      throw new Error('Kimi 非交互模式不支持只读派遣')
    const now = new Date().toISOString()
    const worker: Worker = previous ?? {
      id: randomUUID(),
      parentSessionId: parent,
      project: canonical,
      title: title.slice(0, 160),
      agentName: identity?.agentName
        ? this.checkAgentName(parent, identity.agentName)
        : availableAgentName(this.storage.workers.values(), parent, CLI_SHORT_NAMES[cliOf(preference)]),
      agentNameOrigin: identity?.agentName ? 'custom' : 'auto',
      role: identity?.role ? roleSnapshotSchema.parse(structuredClone(identity.role)) : undefined,
      preference: { ...preference },
      mode,
      createdAt: now,
      updatedAt: now,
      runId: randomUUID(),
      status: 'queued',
    }
    worker.runId = randomUUID()
    worker.status = 'queued'
    worker.error = undefined
    worker.lastResult = undefined
    worker.observedModel = undefined
    worker.updatedAt = now
    worker.jobId = undefined
    this.storage.save(worker)
    this.storage.append(worker, { kind: 'user', text: prompt })
    this.storage.append(worker, { kind: 'status', text: 'queued', state: 'queued' })
    let settle!: (worker: Worker) => void
    const done = new Promise<Worker>((resolve) => {
      settle = resolve
    })
    const controller = new AbortController()
    // Start the own-account read at admission, before this task waits in the queue.
    const admission = authorizedBinding
      ? Promise.resolve(authorizedBinding)
      : readCliAccountBinding(cliOf(effective), this.backend, this.config, canonical, controller.signal)
    void admission.catch((error) => {
      if (error instanceof ProcessCleanupUnconfirmedError) {
        this.markCleanupBlocked(error)
        this.drain()
      }
    })
    const task: Task = {
      worker,
      prompt: promptForWorker(worker, prompt),
      controller,
      done,
      settle,
      admission,
    }
    this.tasks.set(worker.id, task)
    this.queue.push(task)
    this.changed()
    queueMicrotask(() => this.drain())
    return {
      worker,
      done,
      cancel: () => {
        void this.stop(parent, worker.id)
      },
    }
  }
  attachJob(worker: Worker, jobId: string): void {
    worker.jobId = jobId
    this.storage.save(worker)
    this.changed()
  }
  stop(parent: string, id: string): Promise<Worker> {
    const worker = this.get(parent, id)
    const task = this.tasks.get(id)
    if (!task) return Promise.resolve(structuredClone(worker))
    if (worker.status !== 'stopping') {
      worker.status = 'stopping'
      this.storage.save(worker)
      task.controller.abort(new Error('用户已停止任务'))
      this.changed()
      if (!this.running.has(task)) {
        this.queue = this.queue.filter((t) => t !== task)
        void this.finishQueued(task, 'interrupted', '用户已取消排队任务')
      }
    }
    return task.done
  }
  /** A queued task may already own a native account-query process. */
  private async finishQueued(task: Task, status: 'failed' | 'interrupted', reason: string): Promise<void> {
    task.controller.abort(new Error(reason))
    try {
      await task.admission
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) this.markCleanupBlocked(error)
    }
    this.finish(task, this.blocked ? 'failed' : status, this.blocked ?? reason)
  }
  private drain(): void {
    if (this.disposed) return
    if (this.blocked) {
      const queued = this.queue.splice(0)
      for (const task of queued) {
        task.worker.status = 'stopping'
        void this.finishQueued(task, 'failed', this.blocked)
      }
      return
    }
    for (const task of [...this.queue]) {
      if (this.running.size >= this.config.maxConcurrent) break
      const conflicts = (other: Task) =>
        other.worker.project === task.worker.project &&
        (other.worker.mode === 'accept-edits' || task.worker.mode === 'accept-edits')
      if ([...this.running].some(conflicts) || this.queue.slice(0, this.queue.indexOf(task)).some(conflicts))
        continue
      this.queue.splice(this.queue.indexOf(task), 1)
      this.running.add(task)
      void this.run(task).catch((error) => {
        this.finish(task, 'failed', String(error))
      })
    }
  }
  private finish(task: Task, status: Worker['status'], error?: string): void {
    const worker = task.worker
    worker.status = status
    worker.error = error
    worker.updatedAt = new Date().toISOString()
    try {
      this.storage.save(worker)
      this.storage.append(worker, { kind: 'status', text: error ?? status, state: status })
    } catch (error) {
      worker.status = 'failed'
      worker.error = `状态持久化失败：${String(error)}`
      this.blocked = worker.error
    } finally {
      this.tasks.delete(worker.id)
      this.running.delete(task)
      this.changed()
      // A later followup mutates the live worker. Completion consumers must retain
      // the exact outcome of this run, including its runId and response.
      task.settle(structuredClone(worker))
      this.drain()
    }
  }
  private async run(task: Task): Promise<void> {
    const { worker, controller } = task
    let handle: SubprocessHandle | undefined
    let readers: Promise<void>[] = []
    let stderr = ''
    let totalBytes = 0
    const timeout = setTimeout(() => controller.abort(new Error('任务超时')), this.config.timeoutMs)
    const expectedConversation = worker.conversationId
    const protocol = protocolFor(
      cliOf(worker.preference),
      (event) => {
        if (event.observedModel) {
          worker.observedModel = event.observedModel
          this.storage.save(worker)
        }
        this.storage.append(worker, event)
        this.changed()
      },
      (id) => {
        if (expectedConversation && id !== expectedConversation)
          throw new Error('Resume conversation_id does not match the requested conversation')
        worker.conversationId = id
        this.storage.save(worker)
      },
      this.config.maxLineBytes,
      worker.preference.model,
    )
    let failure: unknown
    let release: (() => void | Promise<void>) | undefined
    let quiescent = false
    try {
      const admitted = await task.admission
      controller.signal.throwIfAborted()
      const previousBinding = this.storage.accountBinding(worker.id)
      if (previousBinding && previousBinding !== admitted) throw new Error(ACCOUNT_CHANGED)
      const { binding, preference: authorizedPreference } = await authorizeSelection(
        worker.preference,
        this.backend,
        this.config,
        worker.project,
        controller.signal,
        admitted,
      )
      if (authorizedPreference.model !== worker.preference.model)
        throw new Error('模型与思考强度不匹配，请重新选择')
      controller.signal.throwIfAborted()
      this.assertCliEnabled(cliOf(worker.preference))
      const executable = await resolveCliExecutable(
        cliOf(worker.preference),
        this.backend,
        this.config,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      await assertFirstPartyConfiguration(cliOf(worker.preference), worker.project, controller.signal)
      worker.status = 'running'
      this.storage.save(worker)
      this.changed()
      const launch = isExtendedCli(cliOf(worker.preference))
        ? await extendedLaunch(
            cliOf(worker.preference),
            executable,
            worker.project,
            worker.preference,
            worker.mode,
            task.prompt,
            join(this.storage.directory, 'native', worker.id),
            this.config,
            expectedConversation,
            (argv, env) =>
              captureCatalogMetadata(this.backend, this.config, argv, worker.project, controller.signal, env),
          )
        : {
            env: firstPartyEnvironment(cliOf(worker.preference)),
            argv: workerArguments(
              executable,
              worker.project,
              worker.preference,
              worker.mode,
              task.prompt,
              this.config.timeoutMs,
              expectedConversation,
            ),
          }
      release = 'cleanup' in launch ? launch.cleanup : undefined
      controller.signal.throwIfAborted()
      if (
        binding !==
        (await readCliAccountBinding(
          cliOf(worker.preference),
          this.backend,
          this.config,
          worker.project,
          controller.signal,
        ))
      )
        throw new Error(ACCOUNT_CHANGED)
      controller.signal.throwIfAborted()
      if ('activate' in launch && typeof launch.activate === 'function') await launch.activate()
      controller.signal.throwIfAborted()
      this.storage.bindAccount(worker.id, binding)
      handle = await spawnManagedAgent(this.backend, {
        argv: launch.argv,
        env: 'env' in launch ? launch.env : undefined,
        cwd: worker.project,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.config.graceMs,
        signal: controller.signal,
      })
      // Observe spawn rejection immediately even while draining protocol streams.
      void handle.done.catch(() => undefined)
      const capture = async (stream: SubprocessHandle['stdout'], isError: boolean) => {
        if (!stream) throw new Error('CLI pipe unavailable')
        for await (const chunk of stream) {
          totalBytes += Buffer.byteLength(chunk)
          if (totalBytes > this.config.maxRunBytes)
            throw new Error('CLI output exceeded the configured per-run limit')
          appendFileSync(this.storage.rawPath(worker) + (isError ? '.stderr' : ''), chunk, { mode: 0o600 })
          if (isError) stderr = (stderr + String(chunk)).slice(-8192)
          else protocol.feed(chunk)
        }
      }
      readers = [capture(handle.stdout, false), capture(handle.stderr, true)]
      await Promise.all(readers)
      const outcome = await handle.done
      controller.signal.throwIfAborted()
      protocol.end()
      if (outcome.exitCode !== 0)
        throw new Error(
          `CLI exited with ${outcome.exitCode}: ${stderr || protocol.result?.response || 'no diagnostic'}`,
        )
      if (!protocol.result) throw new Error('CLI exited without a final result')
      if (protocol.result.status !== 'SUCCESS')
        throw new Error(
          `CLI ${protocol.result.status}: ${protocol.result.error || protocol.result.response || stderr || '请检查 CLI 认证及模型/强度兼容性'}`,
        )
      worker.lastResult = protocol.result.response
    } catch (error) {
      failure = error
      if (error instanceof ProcessCleanupUnconfirmedError) this.markCleanupBlocked(error)
    } finally {
      clearTimeout(timeout)
      if (handle) {
        handle.terminate()
        try {
          if (!(await handle.waitForExit())) throw new Error('CLI cleanup did not reach quiescence')
          quiescent = true
        } catch (error) {
          failure = error
          this.markCleanupBlocked(error)
        }
        await Promise.allSettled([...readers, handle.done])
      }
    }
    try {
      if ((!handle || quiescent) && !this.blocked) await release?.()
    } catch (error) {
      failure ??= error
      if (error instanceof ProcessCleanupUnconfirmedError) this.markCleanupBlocked(error)
    }
    if (stderr.trim()) this.storage.append(worker, { kind: 'diagnostic', text: 'CLI 诊断', detail: stderr })
    const error =
      this.blocked ??
      (controller.signal.aborted ? String(controller.signal.reason) : failure ? String(failure) : undefined)
    this.finish(
      task,
      this.blocked
        ? 'failed'
        : failure || controller.signal.aborted
          ? controller.signal.aborted
            ? 'interrupted'
            : 'failed'
          : 'completed',
      error,
    )
  }
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const tasks = [...this.tasks.values()]
    await Promise.all(tasks.map((task) => this.stop(task.worker.parentSessionId, task.worker.id)))
    this.listeners.clear()
    this.storage.close()
  }
}
