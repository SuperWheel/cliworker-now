/** Counts reported by the CLI. Scope is explicit; snapshots must not be added twice. */
export interface TokenUsage {
  total: number
  input?: number
  output?: number
  cacheRead?: number
  scope: 'response' | 'run' | 'session' | 'reported'
}
export interface Telemetry {
  contextEstimated?: boolean
  contextSource?: string
  usage?: TokenUsage
  contextUsed?: number
  contextCapacity?: number
}
export function compactTokens(value: number): string {
  const scaled = (n: number) => String(n >= 100 ? Math.round(n) : Math.round(n * 10) / 10)
  return value < 1000 ? String(value) : value < 1e6 ? `${scaled(value / 1000)}K` : `${scaled(value / 1e6)}M`
}
/** Same calendar-day/year cuts and Chinese templates as Harness formatMessageClock. */
export function messageClock(time: string, now = new Date()): string {
  const d = new Date(time)
  if (!Number.isFinite(d.getTime())) return '—'
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return clock
  const day = `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`
  return d.getFullYear() === now.getFullYear() ? day : `${d.getFullYear()}年 ${day}`
}
