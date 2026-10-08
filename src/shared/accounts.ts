import type { CliId } from './types.ts'

export type AccountAction = 'login' | 'logout' | 'manage'
export type AccountSource = 'native' | 'plugin'
export interface AccountActionDescriptor {
  id: AccountAction
  label: string
  description: string
  target?: 'models'
  /** Logout applies only to the selected source, never all visible accounts. */
  sources?: { id: AccountSource; label: string }[]
}
/** Safe display projection of one authenticated provider; never raw credentials or route URLs. */
export interface AccountLogin {
  providerLabel: string
  authMethod: 'oauth' | 'api'
  /** Optional safe account email for OAuth only; API identities must never be displayed. */
  accountLabel?: string
}
export interface AccountStatus {
  cli: CliId
  installed: boolean
  /** unconfigured is absence; unauthenticated is known invalid/expired auth; unavailable is a read/config error. */
  state: 'authenticated' | 'unconfigured' | 'unauthenticated' | 'configured' | 'unknown' | 'unavailable'
  summary: string
  /** Display-only identity; never a token, API key, or key prefix. */
  authMethod?: 'oauth' | 'api'
  accountLabel?: string
  /** Each current provider retains its own login method. Absent on older Hosts. */
  logins?: AccountLogin[]
  /** A CLI status report or local session metadata, not a remote credential check. */
  verification?: 'cli' | 'local'
  actions: AccountActionDescriptor[]
}
/** Ephemeral, user-operated terminal transport; never stored with worker events. */
export interface AccountFrame {
  seq: number
  data?: string
  status?: 'running' | 'closed' | 'failed'
  message?: string
}
