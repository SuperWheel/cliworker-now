import type { Telemetry, TokenUsage } from './telemetry.ts'
export const EFFORTS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const
export const CLI_IDS = [
  'antigravity',
  'codex',
  'claude',
  'kimi',
  'mimo',
  'zcode',
  'grok',
  'omp',
  'pi',
  'hermes',
  'opencode',
] as const
export type ActiveCliId = (typeof CLI_IDS)[number]
/** Retired IDs remain readable in existing worker history, never selectable for execution. */
export type CliId = ActiveCliId | 'harness'
export const RETIRED_HARNESS_NOTICE =
  '外部 Harness CLI 入口已移除；历史记录仅供查看。请新建 Hermes Agent 任务。'
export const isRetiredCli = (cli: CliId): cli is 'harness' => cli === 'harness'
export const CLI_LABELS: Record<CliId, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude Code',
  kimi: 'Kimi',
  mimo: 'MiMo',
  zcode: 'ZCode',
  grok: 'Grok Build',
  omp: 'OMP',
  pi: 'Pi',
  hermes: 'Hermes Agent',
  harness: 'Harness（已移除）',
  opencode: 'OpenCode',
}
export const cliOf = (preference: Preference): CliId => preference.cli ?? 'antigravity'
export const effortLabel = (effort: string) => (effort === 'default' ? '沿用 CLI 配置' : effort)
export type Effort = (typeof EFFORTS)[number]
export type WorkerStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted'
export type TaskMode = 'plan' | 'accept-edits'
export interface Preference {
  /** Missing in v0.1.x data means Antigravity. */
  cli?: CliId
  model: string
  effort: Effort
}
export interface ModelChoice {
  id: string
  label: string
  efforts?: Effort[]
  /** Exact CLI model IDs for the supported effort variants. */
  variants?: Partial<Record<Effort, string>>
}
/** User-editable role library. Prompts are user instructions, never executable HTML. */
export interface RolePreset {
  id: string
  name: string
  summary: string
  prompt: string
  builtin?: boolean
  source?: string
}
/** Frozen when a worker is created; library edits cannot change an existing conversation. */
export interface RoleSnapshot {
  presetId?: string
  name: string
  summary: string
  prompt: string
}
export interface Worker {
  id: string
  parentSessionId: string
  project: string
  title: string
  agentName?: string
  role?: RoleSnapshot
  preference: Preference
  mode: TaskMode
  conversationId?: string
  status: WorkerStatus
  createdAt: string
  updatedAt: string
  runId: string
  jobId?: string
  error?: string
  observedModel?: string
  lastResult?: string
}
/** Stable, non-mutating name for histories created before named workers. */
export const workerName = (worker: Worker): string => worker.agentName || `智能体-${worker.id.slice(0, 6)}`
export interface WorkerEvent {
  seq: number
  runId: string
  time: string
  kind: 'user' | 'assistant' | 'tool' | 'status' | 'diagnostic' | 'result'
  text: string
  observedModel?: string
  step?: number
  state?: string
  detail?: string
}
export interface TimelineItem {
  usage?: TokenUsage
  id: string
  kind: WorkerEvent['kind']
  text: string
  time: string
  state?: string
  detail?: string
  /** Run ended without a final tool status; the observed CLI state stays intact. */
  runStatus?: WorkerStatus
  runStartedAt?: string
  runEndedAt?: string
  runOutcome?: WorkerStatus
}
export interface WorkerSnapshot {
  telemetry?: Telemetry
  workers: Worker[]
  selected?: Worker
  timeline: TimelineItem[]
  revision: number
  truncated: boolean
}
/** A bounded, frozen reading page; indexes/count refer to the moment it was read. */
export interface HistoryPage {
  workerId: string
  items: TimelineItem[]
  start: number
  end: number
  total: number
  hasOlder: boolean
  hasNewer: boolean
}
export const active = (status: WorkerStatus) =>
  status === 'queued' || status === 'running' || status === 'stopping'

/** Fold repeated step updates without duplicating streamed text or the final response. */
export function foldEvents(
  events: readonly WorkerEvent[],
  endedRun?: { runId: string; status: WorkerStatus },
): TimelineItem[] {
  const rows: TimelineItem[] = []
  const steps = new Map<string, TimelineItem>()
  const markEnded = (runId: string, status: WorkerStatus) => {
    for (const row of rows) {
      if (
        row.kind === 'tool' &&
        row.id.startsWith(runId + ':') &&
        ['ACTIVE', 'RUNNING', 'PENDING', 'QUEUED', 'IN_PROGRESS'].includes(row.state ?? '')
      )
        row.runStatus = status
    }
  }
  for (const event of events) {
    if (event.kind === 'status') {
      const terminal = event.state ?? event.text
      if (terminal === 'completed' || terminal === 'failed' || terminal === 'interrupted')
        markEnded(event.runId, terminal)
    }
    if (event.kind === 'result') {
      const lastAssistant = rows.findLast(
        (row) => row.kind === 'assistant' && row.id.startsWith(event.runId + ':'),
      )
      if (lastAssistant) {
        // agy may repeat all earlier response steps in its final response.
        // Strip only exact earlier prefixes, leaving interleaved tool rows intact.
        let finalText = event.text.trimStart()
        const earlier = rows.filter(
          (row) => row !== lastAssistant && row.kind === 'assistant' && row.id.startsWith(event.runId + ':'),
        )
        for (const row of earlier) {
          const prefix = row.text.trim()
          if (!prefix) continue
          if (finalText.startsWith(prefix)) finalText = finalText.slice(prefix.length).trimStart()
          else break
        }
        if (event.text) lastAssistant.text = finalText
        continue
      }
    }
    const key =
      event.step === undefined
        ? `${event.runId}:event:${event.seq}`
        : `${event.runId}:${event.kind}:${event.step}`
    const existing = steps.get(key)
    if (existing) {
      if (event.kind === 'assistant') existing.text += event.text
      else if (event.text) existing.text = event.text
      if (event.state) existing.state = event.state
      if (event.detail) existing.detail = event.detail
    } else {
      const row: TimelineItem = {
        id: key,
        kind: event.kind === 'result' ? 'assistant' : event.kind,
        text: event.text,
        time: event.time,
        state: event.state,
        detail: event.detail,
      }
      steps.set(key, row)
      rows.push(row)
    }
  }
  // Use full persisted events before pagination. Duration includes admission/queue time.
  const timing = new Map<string, { runStartedAt?: string; runEndedAt?: string; runOutcome?: WorkerStatus }>()
  for (const event of events) {
    const run = timing.get(event.runId) ?? {}
    if (event.kind === 'user' && !run.runStartedAt) run.runStartedAt = event.time
    if (
      event.kind === 'status' &&
      ['completed', 'failed', 'interrupted'].includes(event.state ?? event.text)
    ) {
      run.runEndedAt = event.time
      run.runOutcome = (event.state ?? event.text) as WorkerStatus
    }
    timing.set(event.runId, run)
  }
  for (const row of rows) Object.assign(row, timing.get(row.id.split(':')[0]!))
  if (endedRun) markEnded(endedRun.runId, endedRun.status)
  return rows
}
