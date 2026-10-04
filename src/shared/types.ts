export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export type WorkerStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted'
export type TaskMode = 'plan' | 'accept-edits'
export interface Preference {
  model: string
  effort: Effort
}
export interface ModelChoice {
  id: string
  label: string
}
export interface Worker {
  id: string
  parentSessionId: string
  project: string
  title: string
  preference: Preference
  mode: TaskMode
  conversationId?: string
  status: WorkerStatus
  createdAt: string
  updatedAt: string
  runId: string
  jobId?: string
  error?: string
  lastResult?: string
}
export interface WorkerEvent {
  seq: number
  runId: string
  time: string
  kind: 'user' | 'assistant' | 'tool' | 'status' | 'diagnostic' | 'result'
  text: string
  step?: number
  state?: string
  detail?: string
}
export interface TimelineItem {
  id: string
  kind: WorkerEvent['kind']
  text: string
  time: string
  state?: string
  detail?: string
}
export interface WorkerSnapshot {
  workers: Worker[]
  selected?: Worker
  timeline: TimelineItem[]
  revision: number
  truncated: boolean
}
export const active = (status: WorkerStatus) =>
  status === 'queued' || status === 'running' || status === 'stopping'

/** Fold repeated step updates without duplicating streamed text or the final response. */
export function foldEvents(events: readonly WorkerEvent[]): TimelineItem[] {
  const rows: TimelineItem[] = []
  const steps = new Map<string, TimelineItem>()
  for (const event of events) {
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
  return rows
}
