import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  active,
  foldEvents,
  type Preference,
  type TaskMode,
  type Worker,
  type WorkerSnapshot,
} from '../shared/types.ts'
import { AgyProtocol } from './protocol.ts'
import { spawnManagedAgent } from './managed-agent.ts'
import { agyArguments, projectDirectory, type ProcessBackend, type RuntimeConfig } from './process.ts'
import { WorkerStorage } from './storage.ts'

interface Task {
  worker: Worker
  prompt: string
  controller: AbortController
  done: Promise<Worker>
  settle: (worker: Worker) => void
}
export interface Submission {
  worker: Worker
  done: Promise<Worker>
  cancel: () => void
}

export class WorkerRuntime {
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
  ) {}
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
  get(parent: string, id: string): Worker {
    const worker = this.storage.workers.get(id)
    if (!worker || worker.parentSessionId !== parent)
      throw new Error('Worker does not belong to this conversation')
    return worker
  }
  snapshot(parent: string, selected?: string): WorkerSnapshot {
    const workers = [...this.storage.workers.values()].filter((w) => w.parentSessionId === parent)
    const worker = selected ? this.get(parent, selected) : undefined
    const timeline = worker ? foldEvents(this.storage.history(worker.id)) : []
    return {
      workers,
      selected: worker,
      timeline: timeline.slice(-this.config.maxTimelineItems),
      revision: this.revision,
      truncated: timeline.length > this.config.maxTimelineItems,
    }
  }
  submit(
    parent: string,
    project: string,
    title: string,
    prompt: string,
    preference: Preference,
    mode: TaskMode,
    previousId?: string,
  ): Submission {
    if (this.disposed) throw new Error('CLI Worker is shutting down')
    if (this.blocked) throw new Error(this.blocked)
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('Task must contain 1–100000 characters')
    const canonical = projectDirectory(project)
    const previous = previousId ? this.get(parent, previousId) : undefined
    if (previous && active(previous.status))
      throw new Error('This CLI conversation already has a running or queued turn')
    if (previous && !previous.conversationId)
      throw new Error('No CLI conversation_id was received; start a new worker')
    if (previous && previous.project !== canonical)
      throw new Error('Cannot resume a worker in another workspace')
    const now = new Date().toISOString()
    const worker: Worker = previous ?? {
      id: randomUUID(),
      parentSessionId: parent,
      project: canonical,
      title: title.slice(0, 160),
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
    worker.updatedAt = now
    worker.jobId = undefined
    this.storage.save(worker)
    this.storage.append(worker, { kind: 'user', text: prompt })
    let settle!: (worker: Worker) => void
    const done = new Promise<Worker>((resolve) => {
      settle = resolve
    })
    const task: Task = { worker, prompt, controller: new AbortController(), done, settle }
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
    if (!task) return Promise.resolve(worker)
    if (worker.status !== 'stopping') {
      worker.status = 'stopping'
      this.storage.save(worker)
      task.controller.abort(new Error('用户已停止任务'))
      this.changed()
      if (!this.running.has(task)) {
        this.queue = this.queue.filter((t) => t !== task)
        this.finish(task, 'interrupted', '用户已取消排队任务')
      }
    }
    return task.done
  }
  private drain(): void {
    if (this.disposed) return
    if (this.blocked) {
      const queued = this.queue.splice(0)
      for (const task of queued) this.finish(task, 'failed', this.blocked)
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
      this.storage.append(worker, { kind: 'status', text: error ?? status })
    } catch (error) {
      worker.status = 'failed'
      worker.error = `状态持久化失败：${String(error)}`
      this.blocked = worker.error
    } finally {
      this.tasks.delete(worker.id)
      this.running.delete(task)
      this.changed()
      task.settle(worker)
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
    const protocol = new AgyProtocol(
      (event) => {
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
    )
    let failure: unknown
    try {
      const executable = await this.backend.resolveExecutable(this.config.executable)
      controller.signal.throwIfAborted()
      worker.status = 'running'
      this.storage.save(worker)
      this.changed()
      handle = await spawnManagedAgent(this.backend, {
        argv: agyArguments(
          executable,
          worker.project,
          worker.preference,
          worker.mode,
          task.prompt,
          this.config.timeoutMs,
          expectedConversation,
        ),
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
    } finally {
      clearTimeout(timeout)
      if (handle) {
        handle.terminate()
        try {
          if (!(await handle.waitForExit())) throw new Error('CLI cleanup did not reach quiescence')
        } catch (error) {
          failure = error
          this.blocked = `无法确认 CLI 进程已清理，已暂停后续派遣：${String(error)}`
        }
        await Promise.allSettled([...readers, handle.done])
      }
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
