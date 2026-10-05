import type { CliId } from './types.ts'

/** Harness-profile preferences; independent from project model defaults. */
export interface CliSettings {
  enabled: Record<CliId, boolean>
}
