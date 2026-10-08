import { StringDecoder } from 'node:string_decoder'
import { ProcessCleanupUnconfirmedError, type ProcessBackend, type RuntimeConfig } from './process.ts'
import { accountEmail, type AccountIdentity } from './account-identity.ts'

const LIMIT = 64 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Allowlisted projection of the installed Codex app-server account/read response. */
function projectAccount(value: unknown): AccountIdentity | undefined {
  if (!isRecord(value)) return undefined
  if (value.account === null) return { state: 'unconfigured', summary: '尚未登录', verification: 'cli' }
  if (!isRecord(value.account)) return undefined
  if (value.account.type === 'apiKey')
    return { state: 'authenticated', summary: 'API 登录', authMethod: 'api', verification: 'cli' }
  if (value.account.type === 'chatgpt')
    return {
      state: 'authenticated',
      summary: '已通过 ChatGPT 登录',
      authMethod: 'oauth',
      accountLabel: accountEmail(value.account.email),
      verification: 'cli',
    }
  return undefined
}

/**
 * Use Codex's effective auth store (file/keyring/auto) rather than an auth.json
 * that may belong to an old account. This handshake sends no task, login, or
 * credential refresh request. Older/unsupported servers safely omit identity.
 */
export async function readCodexAccount(
  backend: ProcessBackend,
  config: RuntimeConfig,
  executable: string,
  cwd: string,
  signal: AbortSignal,
): Promise<AccountIdentity | undefined> {
  signal.throwIfAborted()
  const control = AbortSignal.any([signal, AbortSignal.timeout(4_000)])
  const child = backend.spawn({
    argv: [executable, 'app-server', '--stdio'],
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: config.graceMs,
    signal: control,
  })
  void child.done.catch(() => undefined)
  let bytes = 0
  const count = (chunk: unknown) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.byteLength
    if (bytes > LIMIT) throw new Error('Account response too large')
    return buffer
  }
  const inputError = () => undefined
  child.stdin?.on('error', inputError)
  const write = (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (!child.stdin || child.stdin.destroyed) return reject(new Error('Account stdin unavailable'))
      child.stdin.write(JSON.stringify(value) + '\n', (error) => (error ? reject(error) : resolve()))
    })
  const stderr = (async () => {
    if (child.stderr) for await (const chunk of child.stderr) count(chunk)
  })()
  void stderr.catch(() => undefined)
  const stdout = (async (): Promise<AccountIdentity | undefined> => {
    if (!child.stdout) return undefined
    const decoder = new StringDecoder('utf8')
    let pending = '',
      initialized = false
    for await (const chunk of child.stdout) {
      pending += decoder.write(count(chunk))
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let response: unknown
        try {
          response = JSON.parse(line)
        } catch {
          continue
        }
        if (!isRecord(response)) continue
        if (response.id === 1 && !initialized) {
          if (response.error || !isRecord(response.result)) return undefined
          initialized = true
          await write({ method: 'initialized', params: {} })
          await write({ id: 2, method: 'account/read', params: { refreshToken: false } })
        } else if (response.id === 2 && initialized) {
          return response.error ? undefined : projectAccount(response.result)
        }
      }
    }
    return undefined
  })()
  void stdout.catch(() => undefined)
  let cancel: () => void = () => undefined
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('Account lookup cancelled'))
    control.addEventListener('abort', cancel, { once: true })
    if (control.aborted) cancel()
  })
  const failed = new Promise<never>((_, reject) => {
    void stderr.catch(reject)
    void child.done.catch(reject)
  })
  try {
    await Promise.race([
      write({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'cli_worker_account_status', title: 'CLI Worker Account Status', version: '1' },
          capabilities: { experimentalApi: false, requestAttestation: false, explicitGatewayOauth: true },
        },
      }),
      cancelled,
    ])
    return await Promise.race([stdout, cancelled, failed])
  } catch {
    signal.throwIfAborted()
    return undefined
  } finally {
    control.removeEventListener('abort', cancel)
    let exited = false
    try {
      child.terminate()
      exited = await child.waitForExit()
    } catch {
      throw new ProcessCleanupUnconfirmedError()
    }
    if (!exited) throw new ProcessCleanupUnconfirmedError()
    await Promise.allSettled([stdout, stderr, child.done])
    child.stdin?.removeListener('error', inputError)
  }
}
