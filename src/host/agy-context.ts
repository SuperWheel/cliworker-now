import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Telemetry } from '../shared/telemetry.ts'

// Verified against Antigravity CLI 1.2.16's embedded protobuf descriptors:
// CortexStepGeneratorMetadata.chat_model(1) -> ChatModelMetadata.chat_start_metadata(9)
// -> ChatStartMetadata.context_window_metadata(10) -> estimated_tokens_used(1), max_context_tokens(4).
// This is a version-specific, optional local adapter, never a guessed model capacity.
function fields(bytes: Uint8Array): Map<number, number | Uint8Array> {
  let offset = 0
  const result = new Map<number, number | Uint8Array>()
  const integer = (allowUnsafe = false) => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf')
      const byte = bytes[offset++]!
      value |= BigInt(byte & 127) << shift
      if (byte < 128) {
        if (!allowUnsafe && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe integer')
        return Number(value)
      }
    }
    throw new Error('Invalid varint')
  }
  while (offset < bytes.length) {
    const tag = integer(),
      field = Math.floor(tag / 8),
      wire = tag & 7
    if (!field) throw new Error('Invalid field')
    if (wire === 0) result.set(field, integer(true))
    else {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1
      if (length < 0 || offset + length > bytes.length) throw new Error('Invalid field length')
      if (wire === 2) result.set(field, bytes.subarray(offset, offset + length))
      offset += length
    }
  }
  return result
}
export function decodeAgyContext(data: Uint8Array): Telemetry | undefined {
  try {
    let value = data
    for (const key of [1, 9, 10]) {
      const nested = fields(value).get(key)
      if (!(nested instanceof Uint8Array)) return
      value = nested
    }
    const context = fields(value),
      used = context.get(1),
      capacity = context.get(4)
    if (
      typeof used !== 'number' ||
      typeof capacity !== 'number' ||
      !Number.isSafeInteger(used) ||
      !Number.isSafeInteger(capacity) ||
      used < 0 ||
      capacity <= 0
    )
      return
    return {
      contextUsed: used,
      contextCapacity: capacity,
      contextEstimated: true,
      contextSource: 'Antigravity 最近一次请求的本地上下文估算',
    }
  } catch {
    return undefined
  }
}
export class AgyContextReader {
  private cache = new Map<string, { stamp: string; value?: Telemetry }>()
  constructor(private directory = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')) {}
  read(conversationId?: string): Telemetry | undefined {
    if (!conversationId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(conversationId)) return
    const path = join(this.directory, `${conversationId}.db`)
    const stamp = [path, `${path}-wal`]
      .map((file) => {
        try {
          const s = statSync(file)
          return `${s.size}:${s.mtimeMs}`
        } catch {
          return ''
        }
      })
      .join('|')
    if (stamp === '|') return
    const cached = this.cache.get(conversationId)
    if (cached?.stamp === stamp) return cached.value
    let db: DatabaseSync | undefined, value: Telemetry | undefined
    try {
      db = new DatabaseSync(path, { readOnly: true })
      // Verify ownership before reading only this plugin-managed conversation's metadata.
      if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(conversationId))
        return
      const row = db
        .prepare(
          'SELECT CASE WHEN length(data) <= 8388608 THEN data END AS data FROM gen_metadata ORDER BY idx DESC LIMIT 1',
        )
        .get()
      if (row?.data instanceof Uint8Array) value = decodeAgyContext(row.data)
      this.cache.set(conversationId, { stamp, value })
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
      return value
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
}
