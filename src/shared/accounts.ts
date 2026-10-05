import type { CliId } from './types.ts'

export type AccountAction = 'login' | 'logout' | 'manage'
export interface AccountStatus {
  cli: CliId
  installed: boolean
  state: 'authenticated' | 'unauthenticated' | 'configured' | 'unknown' | 'unavailable'
  summary: string
  actions: { id: AccountAction; label: string; description: string }[]
}
/** Ephemeral, user-operated terminal transport; never stored with worker events. */
export interface AccountFrame {
  seq: number
  data?: string
  status?: 'running' | 'closed' | 'failed'
  message?: string
}
