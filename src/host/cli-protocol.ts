import { StringDecoder } from 'node:string_decoder'
import type { CliId } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))
/** Normalizes only public CLI messages. Never synthesizes hidden reasoning. */
export class CliProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private steps = new Map<string, number>()
  private completed = new Set<string>()
  private lastAssistant = ''
  private mimoFinished = false
  private openTools = new Set<string>()
  conversationId?: string
  result?: ProtocolResult
  constructor(
    private cli: Exclude<CliId, 'antigravity'>,
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
    // Kimi print mode has no terminal result envelope. Clean EOF + the exact
    // resume receipt + an assistant answer are required; runtime checks exit 0.
    if (
      this.cli === 'kimi' &&
      !this.result &&
      this.conversationId &&
      this.lastAssistant &&
      !this.openTools.size
    )
      this.finish('SUCCESS', this.lastAssistant)
    if (this.cli === 'mimo' && !this.result && this.conversationId && this.mimoFinished)
      this.finish('SUCCESS', this.lastAssistant)
  }
  private id(id: unknown) {
    if (typeof id !== 'string' || !id.trim()) return
    if (this.conversationId && this.conversationId !== id)
      throw new Error('CLI session ID changed during a run')
    this.identify(id)
    this.conversationId = id
  }
  private step(id: string) {
    if (!this.steps.has(id)) this.steps.set(id, this.steps.size)
    return this.steps.get(id)!
  }
  private assistant(id: string, content: string) {
    if (this.completed.has(id)) return
    this.completed.add(id)
    if (content) {
      this.lastAssistant = content
      this.emit({ kind: 'assistant', step: this.step(id), text: content })
    }
  }
  private tool(id: string, name: string, detail: unknown, done = false, failed = false) {
    if (done) this.openTools.delete(id)
    else this.openTools.add(id)
    this.emit({
      kind: 'tool',
      step: this.step(id),
      text: name,
      detail: text(detail),
      state: failed ? 'FAILED' : done ? 'COMPLETED' : 'RUNNING',
    })
  }
  private finish(status: string, response: string, error?: string) {
    if (this.result) throw new Error('Duplicate CLI result')
    if (!this.conversationId) throw new Error('CLI result is missing its session ID')
    this.result = { conversationId: this.conversationId, status, response, error }
    this.emit({ kind: 'result', text: response, state: status })
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
    let v: Record<string, any>
    try {
      v = JSON.parse(line)
    } catch {
      throw new Error(`Invalid ${this.cli} JSONL event`)
    }
    if (!object(v)) throw new Error('Invalid CLI event object')
    // Claude may emit hook/metrics metadata after the result. It cannot modify
    // text, identity or the final result; contradictory terminal events fail.
    if (this.result) {
      if (
        v.type === 'result' ||
        v.type === 'turn.completed' ||
        v.type === 'turn.failed' ||
        v.type === 'error' ||
        v.role === 'assistant'
      )
        throw new Error('Unexpected output after CLI result')
      this.id(v.session_id ?? v.thread_id)
      return
    }
    if (this.cli === 'codex') {
      if (typeof v.type !== 'string') throw new Error('Missing Codex event discriminator')
      if (v.type === 'thread.started') {
        this.id(v.thread_id)
        this.emit({ kind: 'status', text: 'Codex 已连接' })
      } else if (v.type.startsWith('item.') && object(v.item)) {
        const item = v.item,
          id = String(item.id),
          done = v.type === 'item.completed'
        if (item.type === 'agent_message' && done) this.assistant(id, text(item.text ?? ''))
        else if (
          ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list'].includes(item.type)
        )
          this.tool(id, item.command ?? item.tool ?? item.type, item, done, item.status === 'failed')
        // Reasoning items are deliberately omitted from the conversation view.
      } else if (v.type === 'turn.completed') this.finish('SUCCESS', this.lastAssistant)
      else if (v.type === 'turn.failed') this.finish('ERROR', this.lastAssistant, text(v.error))
      else if (v.type === 'error') this.emit({ kind: 'diagnostic', text: text(v.message ?? v.error) })
    } else if (this.cli === 'claude') {
      if (typeof v.type !== 'string') throw new Error('Missing Claude event discriminator')
      this.id(v.session_id)
      if (v.type === 'system' && v.subtype === 'init')
        this.emit({
          kind: 'status',
          text: 'Claude Code 已连接',
          observedModel: typeof v.model === 'string' ? v.model : undefined,
        })
      else if (v.type === 'assistant' && object(v.message)) {
        for (const [i, block] of (v.message.content ?? []).entries()) {
          if (block.type === 'text') this.assistant(`${v.message.id}:${i}`, text(block.text))
          else if (block.type === 'tool_use') this.tool(block.id, block.name, block.input)
        }
      } else if (v.type === 'user' && object(v.message)) {
        for (const block of v.message.content ?? [])
          if (block.type === 'tool_result')
            this.tool(block.tool_use_id, '', block.content, true, !!block.is_error)
      } else if (v.type === 'result') {
        const denied = Array.isArray(v.permission_denials) && v.permission_denials.length > 0
        this.finish(
          v.is_error || denied || v.subtype !== 'success' ? 'ERROR' : 'SUCCESS',
          text(v.result ?? this.lastAssistant),
          denied ? '工具权限被拒绝；未执行的操作不能视为完成。' : v.errors ? text(v.errors) : undefined,
        )
      }
    } else if (this.cli === 'mimo') {
      if (typeof v.type !== 'string') throw new Error('Missing MiMo event discriminator')
      this.id(v.sessionID)
      const part = v.part
      if (v.type === 'step_start') {
        this.mimoFinished = false
        this.emit({ kind: 'status', text: 'MiMo 工作中' })
      } else if (v.type === 'text' && object(part)) this.assistant(String(part.id), text(part.text ?? ''))
      else if (v.type === 'tool_use' && object(part))
        this.tool(
          String(part.callID ?? part.id),
          part.tool ?? '工具',
          part.state,
          true,
          part.state?.status === 'error',
        )
      else if (v.type === 'step_finish') this.mimoFinished = part?.reason === 'stop'
      else if (v.type === 'error') this.finish('ERROR', this.lastAssistant, text(v.error))
    } else {
      if (typeof v.role !== 'string') throw new Error('Missing Kimi role discriminator')
      if (v.role === 'meta' && v.type === 'session.resume_hint') {
        this.id(v.session_id)
        this.emit({ kind: 'status', text: 'Kimi 会话已保存' })
      } else if (v.role === 'assistant') {
        if (typeof v.content === 'string') this.assistant(`message:${this.steps.size}`, v.content)
        if (v.tool_calls?.length) this.lastAssistant = ''
        for (const call of v.tool_calls ?? [])
          this.tool(call.id, call.function?.name ?? '工具', call.function?.arguments ?? '')
      } else if (v.role === 'tool') this.tool(v.tool_call_id, '', v.content, true)
      else if (v.role === 'meta')
        this.emit({ kind: 'diagnostic', text: String(v.type ?? 'Kimi metadata'), detail: line })
      else throw new Error(`Unsupported Kimi message role: ${v.role}`)
    }
  }
}
