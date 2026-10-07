import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliId } from '../shared/types.ts'
import type { AccountStatus } from '../shared/accounts.ts'

export type AccountIdentity = Pick<
  AccountStatus,
  'state' | 'summary' | 'authMethod' | 'accountLabel' | 'verification'
>
export type AccountIdentitySource = (cli: CliId, signal: AbortSignal) => Promise<AccountIdentity | undefined>

const LIMIT = 64 * 1024
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const credentialPresent = (value: unknown) => typeof value === 'string' && value.trim().length > 0

/** Only email is allowlisted. Reject controls/markup/credential-shaped strings outright. */
export function accountEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 254) return undefined
  if (/\p{C}|[<>]|\b(?:Bearer|sk-|sk_|ghp_|ya29\.)/iu.test(value)) return undefined
  const email = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : undefined
}

function idTokenClaims(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length > 32 * 1024) return undefined
  const pieces = value.split('.')
  if (pieces.length !== 3 || !pieces.every((piece) => /^[A-Za-z0-9_-]+$/.test(piece))) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString('utf8'))
    return record(claims) ? claims : undefined
  } catch {
    return undefined
  }
}

/** Local expiry is negative evidence only; an unsigned claim never proves login. */
export function localTokenExpired(value: unknown, now = Date.now()): boolean {
  const expiry = idTokenClaims(value)?.exp
  return typeof expiry === 'number' && Number.isFinite(expiry) && expiry * 1000 <= now
}

/**
 * This format/path is verified from the installed AGY CLI. Reading is
 * bounded and ephemeral. No credential leaves this function; ID tokens are decoded
 * only for a display email, never treated as a remotely verified assertion.
 */
export function localAccountIdentity(
  options: {
    home?: string
  } = {},
): AccountIdentitySource {
  return async (cli, signal) => {
    if (cli !== 'antigravity') return undefined
    const home = options.home ?? homedir()
    const path = join(home, '.gemini', 'jetski-standalone-oauth-token')
    let handle
    let buffer: Buffer | undefined
    try {
      signal.throwIfAborted()
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT) throw new Error('Invalid account metadata')
      buffer = Buffer.alloc(LIMIT + 1)
      let offset = 0
      while (offset <= LIMIT) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > LIMIT) throw new Error('Invalid account metadata')
      const value: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8'))
      signal.throwIfAborted()
      if (!record(value)) throw new Error('Invalid account metadata')
      if (value.auth_method !== 'consumer' || !record(value.token))
        return {
          state: 'unknown',
          verification: 'local',
          summary: '暂时无法识别本地登录信息，可在账号终端查看',
        }
      const refreshable = credentialPresent(value.token.refresh_token)
      const expiry = typeof value.token.expiry === 'string' ? Date.parse(value.token.expiry) : NaN
      const active =
        credentialPresent(value.token.access_token) && Number.isFinite(expiry) && expiry > Date.now()
      if (!refreshable && !active)
        return { state: 'unauthenticated', verification: 'local', summary: '本地登录已过期，请重新登录' }
      return {
        state: 'authenticated',
        authMethod: 'oauth',
        verification: 'local',
        accountLabel: accountEmail(idTokenClaims(value.id_token)?.email),
        summary: '本地登录会话已保存；未进行远程有效性校验',
      }
    } catch (error) {
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return { state: 'unconfigured', verification: 'local', summary: '尚未登录 Antigravity' }
      return {
        state: 'unavailable',
        verification: 'local',
        summary: '暂时无法读取本地登录状态，可在账号终端查看',
      }
    } finally {
      buffer?.fill(0)
      await handle?.close().catch(() => undefined)
    }
  }
}
