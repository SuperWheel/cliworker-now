import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { EFFORTS, active, type Preference, type Worker, type WorkerEvent } from '../shared/types.ts'

const preferenceSchema = z.object({ model: z.string().min(1), effort: z.enum(EFFORTS) })
const workerSchema = z.object({
  id: z.uuid(),
  parentSessionId: z.string().min(1),
  project: z.string().min(1),
  title: z.string(),
  preference: preferenceSchema,
  mode: z.enum(['plan', 'accept-edits']),
  conversationId: z.string().optional(),
  status: z.enum(['queued', 'running', 'stopping', 'completed', 'failed', 'interrupted']),
  createdAt: z.string(),
  updatedAt: z.string(),
  runId: z.uuid(),
  jobId: z.string().optional(),
  error: z.string().optional(),
  lastResult: z.string().optional(),
})
const eventSchema = z.object({
  seq: z.number().int().positive(),
  runId: z.uuid(),
  time: z.string(),
  kind: z.enum(['user', 'assistant', 'tool', 'status', 'diagnostic', 'result']),
  text: z.string(),
  step: z.number().optional(),
  state: z.string().optional(),
  detail: z.string().optional(),
})

export function atomicJSON(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp)
  }
}

/** One host owns a private store; a live second host cannot resume the same CLI session. */
export class WorkerStorage {
  readonly workers = new Map<string, Worker>()
  private events = new Map<string, WorkerEvent[]>()
  private token = randomUUID()
  private lock: string
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    this.lock = join(directory, 'host.lock')
    if (existsSync(this.lock)) {
      const owner = JSON.parse(readFileSync(this.lock, 'utf8')) as { pid: number }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Invalid store lock; inspect host.lock before recovery')
      let alive = true
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
        else throw error
      }
      if (alive) throw new Error('CLI Worker store is already owned by another Harness host')
      rmSync(this.lock)
    }
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.token }), {
      mode: 0o600,
      flag: 'wx',
    })
    try {
      for (const file of readdirSync(directory).filter((name) => name.endsWith('.worker.json'))) {
        const worker = workerSchema.parse(JSON.parse(readFileSync(join(directory, file), 'utf8')))
        if (`${worker.id}.worker.json` !== file) throw new Error('Worker storage identity mismatch')
        this.workers.set(worker.id, worker)
        if (active(worker.status)) {
          worker.status = 'interrupted'
          worker.error = '上次 Harness 运行中断；可继续原会话'
          this.save(worker)
          this.append(worker, { kind: 'status', text: worker.error, state: 'interrupted' })
        }
      }
    } catch (error) {
      this.close()
      throw error
    }
  }
  private projectKey(project: string): string {
    return createHash('sha256').update(project).digest('hex')
  }
  preference(project: string): Preference | undefined {
    const path = join(this.directory, `${this.projectKey(project)}.preference.json`)
    return existsSync(path) ? preferenceSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined
  }
  setPreference(project: string, preference: Preference): void {
    atomicJSON(
      join(this.directory, `${this.projectKey(project)}.preference.json`),
      preferenceSchema.parse(preference),
    )
  }
  save(worker: Worker): void {
    atomicJSON(join(this.directory, `${worker.id}.worker.json`), worker)
    this.workers.set(worker.id, worker)
  }
  history(id: string): WorkerEvent[] {
    if (!this.workers.has(id)) throw new Error('Unknown worker')
    const cached = this.events.get(id)
    if (cached) return cached
    const path = join(this.directory, `${id}.events.jsonl`)
    const rows: WorkerEvent[] = []
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8')
      const lines = raw.split('\n')
      // Only a torn final append is discarded. Earlier corruption is never silently skipped.
      const complete = lines.slice(0, -1)
      for (const line of complete) {
        const event = eventSchema.parse(JSON.parse(line))
        if (event.seq !== rows.length + 1) throw new Error('Event sequence corruption')
        rows.push(event)
      }
      if (!raw.endsWith('\n')) {
        writeFileSync(path, complete.join('\n') + (complete.length ? '\n' : ''), { mode: 0o600 })
      }
    }
    this.events.set(id, rows)
    return rows
  }
  append(worker: Worker, event: Omit<WorkerEvent, 'seq' | 'runId' | 'time'>): void {
    const rows = this.history(worker.id)
    const row = { ...event, seq: rows.length + 1, runId: worker.runId, time: new Date().toISOString() }
    appendFileSync(join(this.directory, `${worker.id}.events.jsonl`), JSON.stringify(row) + '\n', {
      mode: 0o600,
    })
    rows.push(row)
  }
  rawPath(worker: Worker): string {
    return join(this.directory, `${worker.id}.${worker.runId}.raw.jsonl`)
  }
  close(): void {
    if (existsSync(this.lock) && JSON.parse(readFileSync(this.lock, 'utf8')).token === this.token)
      rmSync(this.lock)
  }
}
