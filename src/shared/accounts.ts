import type { CliId } from './types.ts'

export type AccountAction = 'login' | 'logout' | 'manage'
export interface AccountStatus {
  cli: CliId
  installed: boolean
  /** unconfigured is absence; unauthenticated is known invalid/expired auth; unavailable is a read/config error. */
  state: 'authenticated' | 'unconfigured' | 'unauthenticated' | 'configured' | 'unknown' | 'unavailable'
  summary: string
  /** Display-only identity; never a token, API key, or key prefix. */
  authMethod?: 'oauth' | 'api'
  accountLabel?: string
  /** A CLI status report or local session metadata, not a remote credential check. */
  verification?: 'cli' | 'local'
  actions: { id: AccountAction; label: string; description: string; target?: 'models' }[]
}
/** Ephemeral, user-operated terminal transport; never stored with worker events. */
export interface AccountFrame {
  seq: number
  data?: string
  status?: 'running' | 'closed' | 'failed'
  message?: string
}
