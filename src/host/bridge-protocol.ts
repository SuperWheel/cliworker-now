import { StringDecoder } from 'node:string_decoder'
import type { EventInput, ProtocolResult } from './protocol.ts'

/** Internal framing for the Pi/OMP RPC bridge; never accepts arbitrary event kinds. */
export class BridgeProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  conversationId?: string
  result?: ProtocolResult
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string) {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + 1)
      if (line) this.line(line)
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('CLI bridge event too large')
  }
  end() {
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI bridge event too large')
    const v = JSON.parse(line)
    if (!v || typeof v !== 'object' || this.result) throw new Error('Unexpected CLI bridge frame')
    if (v.type === 'session') {
      if (typeof v.id !== 'string' || !v.id || (this.conversationId && this.conversationId !== v.id))
        throw new Error('CLI session identity changed')
      this.identify(v.id)
      this.conversationId = v.id
      this.emit({
        kind: 'status',
        text: 'CLI 已连接',
        observedModel: typeof v.model === 'string' ? v.model : undefined,
      })
    } else if (v.type === 'event') {
      const e = v.event
      if (!e || !['assistant', 'tool', 'status', 'diagnostic'].includes(e.kind) || typeof e.text !== 'string')
        throw new Error('Invalid bridge event')
      this.emit({
        kind: e.kind,
        text: e.text,
        ...(Number.isInteger(e.step) ? { step: e.step } : {}),
        ...(typeof e.state === 'string' ? { state: e.state } : {}),
        ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
      })
    } else if (v.type === 'result') {
      if (!this.conversationId && v.status === 'ERROR' && typeof v.error === 'string') throw new Error(v.error.slice(0, 4096))
      if (!this.conversationId || !['SUCCESS', 'ERROR'].includes(v.status) || typeof v.response !== 'string')
        throw new Error('Invalid bridge result')
      this.result = {
        conversationId: this.conversationId,
        status: v.status,
        response: v.response,
        error: typeof v.error === 'string' ? v.error : undefined,
      }
      this.emit({ kind: 'result', text: v.response, state: v.status })
    } else throw new Error('Unknown CLI bridge frame')
  }
}
