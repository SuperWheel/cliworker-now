import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { hermesTokenUsage } from './hermes-adapter.ts'
import type { CliId, TimelineItem } from '../shared/types.ts'
import type { Telemetry, TokenUsage } from '../shared/telemetry.ts'

const obj = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
function usage(v: unknown, scope: TokenUsage['scope'], cacheSeparate = false): TokenUsage | undefined {
  const u = obj(v),
    input = count(u.input_tokens),
    output = count(u.output_tokens)
  const cacheRead = count(u.cache_read_tokens ?? u.cache_read_input_tokens ?? u.cached_input_tokens)
  const creation = count(u.cache_creation_input_tokens)
  const total =
    count(u.total_tokens) ??
    (input !== undefined && output !== undefined
      ? input + output + (cacheSeparate ? (cacheRead ?? 0) + (creation ?? 0) : 0)
      : undefined)
  return total === undefined || !Number.isSafeInteger(total)
    ? undefined
    : { total, input, output, cacheRead, scope }
}
export interface RunTelemetry extends Telemetry {
  replies: Record<string, TokenUsage>
  finalReply?: TokenUsage
}
/** Only public, observed CLI envelopes; no model-name capacity guesses. */
export function extractTelemetry(cli: CliId, records: readonly unknown[]): RunTelemetry {
  const result: RunTelemetry = { replies: {} }
  const mimoSteps = new Map<string, TokenUsage>()
  for (const record of records) {
    const v = obj(record)
    if (cli === 'antigravity') {
      const step = obj(v.step_update)
      if (
        v.event === 'step_update' &&
        step.step_type === 'agent_response' &&
        Number.isInteger(step.step_index)
      ) {
        const u = usage(step.usage, 'response')
        if (u) result.replies[String(step.step_index)] = u
      }
      if (v.event === 'result') result.usage = usage(obj(v.result).usage, 'session') ?? result.usage
    } else if (cli === 'codex' && v.type === 'turn.completed') {
      // CLI's receipt does not reliably distinguish resumed-thread vs turn counters.
      result.usage = usage(v.usage, 'reported') ?? result.usage
      result.finalReply = result.usage
    } else if (cli === 'hermes' && v.type === 'result') {
      result.usage = hermesTokenUsage(v.tokens) ?? result.usage
      result.finalReply = result.usage
    } else if (cli === 'claude' && v.type === 'result') {
      result.usage = usage(v.usage, 'run', true) ?? result.usage
      result.finalReply = result.usage
      const models = Object.values(obj(v.modelUsage))
      if (models.length === 1) result.contextCapacity = count(obj(models[0]).contextWindow) || undefined
    } else if (cli === 'mimo' && v.type === 'step_finish') {
      const part = obj(v.part),
        t = obj(part.tokens)
      const u = usage(
        {
          total_tokens: t.total,
          input_tokens: t.input,
          output_tokens: t.output,
          cache_read_tokens: obj(t.cache).read,
        },
        'response',
      )
      if (u && typeof part.id === 'string') mimoSteps.set(part.id, u)
    }
    // Only explicit occupancy fields count as context, never cumulative input/total usage.
    const context = obj(v.context_usage)
    const used = count(context.used_tokens),
      capacity = count(context.max_tokens)
    if (used !== undefined) result.contextUsed = used
    if (capacity !== undefined && capacity > 0) result.contextCapacity = capacity
  }
  if (mimoSteps.size) {
    result.usage = { total: [...mimoSteps.values()].reduce((n, u) => n + u.total, 0), scope: 'run' }
    result.finalReply = result.usage
  }
  return result
}

/** Read-only projection also recovers telemetry from pre-feature private raw logs.
 * Incremental byte reads keep live polling O(new bytes), with bounded cache/line memory.
 * Malformed/torn records affect telemetry only, never conversation restoration.
 */
export class TelemetryReader {
  private cache = new Map<
    string,
    { size: number; mtime: number; records: unknown[]; pending: string; result: RunTelemetry }
  >()
  read(path: string, cli: CliId): RunTelemetry {
    let stat
    try {
      stat = statSync(path)
    } catch {
      return { replies: {} }
    }
    let entry = this.cache.get(path)
    if (entry && entry.size === stat.size && entry.mtime === stat.mtimeMs) return entry.result
    if (!entry || stat.size < entry.size || (stat.size === entry.size && stat.mtimeMs !== entry.mtime))
      entry = { size: 0, mtime: 0, records: [], pending: '', result: { replies: {} } }
    // Bound unexpected raw output. A missing meter must never break a conversation.
    if (stat.size > 64 * 1024 * 1024) return { replies: {} }
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const buf = Buffer.alloc(stat.size - entry.size)
      const n = readSync(fd, buf, 0, buf.length, entry.size)
      const lines = (entry.pending + buf.subarray(0, n).toString('utf8')).split('\n')
      entry.pending = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const v = JSON.parse(line),
            step = obj(v.step_update)
          // Retain only metric envelopes, not conversation text/tool output.
          if (v.event === 'step_update' && step.usage)
            entry.records.push({
              event: v.event,
              step_update: { step_type: step.step_type, step_index: step.step_index, usage: step.usage },
            })
          else if (v.event === 'result')
            entry.records.push({ event: v.event, result: { usage: obj(v.result).usage } })
          else if (v.type === 'result' || v.type === 'turn.completed')
            entry.records.push({ type: v.type, usage: v.usage, modelUsage: v.modelUsage, tokens: v.tokens })
          else if (v.type === 'step_finish') entry.records.push({ type: v.type, part: v.part })
          if (v.context_usage) entry.records.push({ context_usage: v.context_usage })
        } catch {
          /* Ignore diagnostics and incomplete JSON. */
        }
      }
      if (entry.records.length > 10000) return { replies: {} }
      entry.size += n
      entry.mtime = stat.mtimeMs
      entry.result = extractTelemetry(cli, entry.records)
      this.cache.delete(path)
      this.cache.set(path, entry)
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
      return entry.result
    } catch {
      return { replies: {} }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}
export function attachTelemetry(rows: TimelineItem[], runId: string, telemetry: RunTelemetry) {
  const replies = rows.filter((row) => row.kind === 'assistant' && row.id.startsWith(`${runId}:`))
  for (const row of replies) {
    const step = row.id.split(':')[1] === 'assistant' ? row.id.split(':')[2] : undefined
    if (step !== undefined && telemetry.replies[step]) row.usage = telemetry.replies[step]
  }
  const last = replies.at(-1)
  if (last && !last.usage) last.usage = telemetry.finalReply
}
