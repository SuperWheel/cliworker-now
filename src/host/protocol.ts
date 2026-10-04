import { StringDecoder } from 'node:string_decoder'
import type { WorkerEvent } from '../shared/types.ts'

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
export interface ProtocolResult {
  conversationId: string
  status: string
  response: string
  error?: string
}
export type EventInput = Omit<WorkerEvent, 'seq' | 'runId' | 'time'>

/** Antigravity 1.2.16 NDJSON framing, including split UTF-8 characters. */
export class AgyProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  result?: ProtocolResult
  conversationId?: string
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + 1)
      if (line) this.line(line)
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
  }
  end(): void {
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
  }
  private id(value: unknown): void {
    if (typeof value !== 'string' || !value.trim()) return
    if (this.conversationId && this.conversationId !== value)
      throw new Error('CLI conversation_id changed during a run')
    this.identify(value)
    this.conversationId = value
  }
  private line(line: string): void {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('Invalid Antigravity stream-json event')
    }
    if (!record(value) || typeof value.event !== 'string')
      throw new Error('Missing Antigravity event discriminator')
    if (this.result) throw new Error('Unexpected event after CLI result')
    this.id(value.conversation_id)
    if (value.event === 'init') {
      this.emit({
        kind: 'status',
        text: 'CLI 已连接',
        detail: JSON.stringify(value.init ?? {}),
        observedModel:
          record(value.init) && typeof value.init.model === 'string' ? value.init.model : undefined,
      })
    } else if (value.event === 'step_update') {
      const step = value.step_update
      if (!record(step)) throw new Error('Invalid step_update payload')
      this.id(step.conversation_id)
      const number = typeof step.step_index === 'number' ? step.step_index : undefined
      const state = typeof step.state === 'string' ? step.state : undefined
      if (step.step_type === 'agent_response') {
        this.emit({
          kind: 'assistant',
          step: number,
          state,
          text: typeof step.text_delta === 'string' ? step.text_delta : '',
        })
      } else if (step.step_type === 'tool') {
        this.emit({
          kind: 'tool',
          step: number,
          state,
          text: String(step.tool_name ?? '工具'),
          detail: JSON.stringify(step.tool_info ?? {}, null, 2),
        })
      }
    } else if (value.event === 'result') {
      const result = value.result
      if (
        !record(result) ||
        typeof result.conversation_id !== 'string' ||
        typeof result.status !== 'string' ||
        typeof result.response !== 'string'
      )
        throw new Error('Invalid CLI result payload')
      this.id(result.conversation_id)
      this.result = {
        conversationId: result.conversation_id,
        status: result.status,
        response: result.response,
        error: typeof result.error === 'string' ? result.error : undefined,
      }
      this.emit({ kind: 'result', text: result.response, state: result.status })
    } else {
      this.emit({ kind: 'diagnostic', text: `未识别事件：${value.event}`, detail: line })
    }
  }
}
