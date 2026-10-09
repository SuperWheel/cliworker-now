import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { homedir, platform, userInfo } from 'node:os'
import { constants } from 'node:fs'
import { createHash, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { AccountAction } from '../shared/accounts.ts'
import { accountEmail, localTokenExpired, type AccountIdentity } from './account-identity.ts'
import type { ProcessBackend, RuntimeConfig } from './process.ts'
import { readZCodePersonalIdentity, zcodeAuthDirectory, zcodeEnvironment } from './zcode-adapter.ts'
import { assertGrokNativeEnvironment, selectGrokOwnAccount } from './grok-models.ts'

export type ZCodeGrokCli = 'zcode' | 'grok'
export interface ZCodeGrokAccountLaunch {
  argv: string[]
  env: Record<string, string>
  cwd: string
  instruction: string
}

/** Safe to show in the UI; never constructed from native CLI output. */
export class ZCodeAccountCapabilityError extends Error {}

// Set umask in a dedicated child, never in the shared Harness Host process.
const privateArgv = (argv: string[]) => [
  process.execPath,
  fileURLToPath(new URL('./private-launch.mjs', import.meta.url)),
  ...argv,
]

export function zcodeGrokInstruction(cli: ZCodeGrokCli, action: AccountAction): string {
  if (cli === 'zcode') {
    if (action === 'login') return '按 ZCode 原生提示完成 BigModel 授权；此账号供本插件的 ZCode 任务使用。'
    if (action === 'logout') return '此操作会退出该独立配置中的 Z.AI 和 BigModel Coding Plan 账号。'
    return '在 ZCode 原生终端输入 /login 或 /logout 管理账号。'
  }
  if (action === 'login') return '按 Grok 原生提示完成浏览器授权；使用 Grok 本机账号，插件任务读取同一账号。'
  if (action === 'logout') return '按 Grok 原生流程退出本机账号；其他使用该 Grok 账号的终端也将受到影响。'
  return '在 Grok 原生终端管理账号。'
}

function storageRoot(config: RuntimeConfig, home: string): string {
  return config.stateDirectory ?? join(process.env.DSH_HOME ?? join(home, '.dsh'), 'cliworker-now')
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

/** ZCode 0.16.9 native AES-GCM format. Plaintext never leaves this projection. */
export function projectZCodeIdentity(raw: unknown, secret: string): AccountIdentity {
  if (!record(raw)) throw new Error('Invalid account metadata')
  const key = createHash('sha256').update(secret).digest()
  const decode = (value: unknown): string => {
    if (!nonempty(value)) return ''
    if (!value.startsWith('enc:v1:')) return value
    const parts = value.slice(7).split('.')
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error('Invalid encrypted account metadata')
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'))
    if (iv!.length !== 12 || tag!.length !== 16) throw new Error('Invalid account cipher')
    const cipher = createDecipheriv('aes-256-gcm', key, iv!)
    cipher.setAuthTag(tag!)
    const plain = Buffer.concat([cipher.update(encrypted!), cipher.final()])
    try {
      return plain.toString('utf8')
    } finally {
      plain.fill(0)
    }
  }
  try {
    const provider = decode(raw['oauth:active_provider']).trim()
    const userInfo = (family: string): Record<string, unknown> | undefined => {
      try {
        const info: unknown = JSON.parse(decode(raw[`oauth:${family}:user_info`]))
        return record(info) ? info : undefined
      } catch {
        return undefined
      }
    }
    const label = (info: Record<string, unknown> | undefined): string | undefined => {
      const profile = record(info?.rawProfile) ? info.rawProfile : undefined
      const email = accountEmail(profile?.email) || accountEmail(info?.email) || accountEmail(info?.username)
      const name = info?.displayName
      const display =
        typeof name === 'string' && name.length <= 80 && !/[\p{C}<>]|(?:Bearer|sk-|enc:v1:)/iu.test(name)
          ? name.trim()
          : undefined
      return email || display || undefined
    }
    let bound = false
    let apiBinding = false
    for (const family of ['bigmodel', 'zai']) {
      const nativeProvider = `account:${family}-individual-coding-plan`
      const identity = decode(raw[`account-provider:${nativeProvider}:identity`]).trim()
      if (!identity) continue
      const apiKey = decode(
        raw[`account-provider:coding-plan:${nativeProvider}:account:${encodeURIComponent(identity)}:api-key`],
      ).trim()
      if (!apiKey) continue
      bound = true
      // Native API setup also persists a binding, using a fingerprint identity.
      // It remains API configuration rather than an OAuth login.
      if (/^key-[a-f0-9]{24}$/.test(identity)) {
        apiBinding ||= identity === `key-${createHash('sha256').update(apiKey).digest('hex').slice(0, 24)}`
        continue
      }
      const info = userInfo(family)
      const profile = record(info?.rawProfile) ? info.rawProfile : undefined
      const userIds = (family === 'zai' ? [info?.user_id] : [info?.id, profile?.user_id]).filter(
        (id) => id !== undefined,
      )
      if (
        provider === family &&
        userIds.length &&
        userIds.every((id) => nonempty(id) && id.trim() === identity)
      ) {
        // Native login saves these together; native logout removes both binding
        // entries. The Worker uses this key even after its OAuth access expires.
        return {
          state: 'authenticated',
          authMethod: 'oauth',
          verification: 'local',
          accountLabel: label(info),
          summary: '已登录 ZCode',
        }
      }
    }
    if (bound)
      return {
        state: 'configured',
        verification: 'local',
        ...(apiBinding ? { authMethod: 'api' as const } : {}),
        summary: apiBinding ? '已配置 ZCode API' : '已配置 ZCode 账号',
      }
    if (
      !provider &&
      Object.keys(raw).some((name) => {
        const match = /^account-provider:(.+):identity$/.exec(name)
        return (
          match &&
          !['account:bigmodel-individual-coding-plan', 'account:zai-individual-coding-plan'].includes(
            match[1]!,
          ) &&
          nonempty(raw[name])
        )
      })
    )
      return { state: 'unknown', verification: 'local', summary: '账号类型未知' }
    if (provider !== 'bigmodel' && provider !== 'zai')
      return provider
        ? { state: 'unknown', verification: 'local', summary: '登录服务商未知' }
        : { state: 'unconfigured', verification: 'local', summary: '尚未登录 ZCode' }
    const access = decode(raw[`oauth:${provider}:access_token`])
    const refresh = decode(raw[`oauth:${provider}:refresh_token`])
    if (!access && !refresh)
      return { state: 'unauthenticated', verification: 'local', summary: '本地登录凭据已清除' }
    if (localTokenExpired(access))
      return {
        state: 'unauthenticated',
        verification: 'local',
        authMethod: 'oauth',
        summary: '登录已过期，请重新登录',
      }
    return {
      state: 'configured',
      authMethod: 'oauth',
      verification: 'local',
      accountLabel: label(userInfo(provider)),
      summary: access ? '已配置 ZCode OAuth' : '已保存 ZCode 续期凭据',
    }
  } finally {
    key.fill(0)
  }
}

export function projectGrokIdentity(raw: unknown, now = Date.now()): AccountIdentity {
  if (!record(raw)) throw new Error('Invalid account metadata')
  const account = selectGrokOwnAccount(raw, now)
  if (account && (account.active || account.refresh)) {
    return {
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'local',
      accountLabel: account.email,
      summary: '已登录 Grok',
    }
  }
  return {
    state: account ? 'unauthenticated' : Object.keys(raw).length ? 'unknown' : 'unconfigured',
    verification: 'local',
    summary: account ? '登录已过期，请重新登录' : Object.keys(raw).length ? '登录格式未知' : '尚未登录 Grok',
  }
}

/** Bounded, no-follow local read; never returns credentials or native parse errors. */
export async function zcodeGrokAccountStatus(
  cli: ZCodeGrokCli,
  config: RuntimeConfig,
  signal: AbortSignal,
  options: { home?: string; credentialSecret?: string } = {},
): Promise<AccountIdentity> {
  signal.throwIfAborted()
  const home = options.home ?? homedir()
  const path =
    cli === 'zcode'
      ? join(
          zcodeAuthDirectory(config.zcodeAuthDirectory, storageRoot(config, home)),
          '.zcode/v2/credentials.json',
        )
      : join(home, '.grok/auth.json')
  let file: Awaited<ReturnType<typeof open>> | undefined
  const buffer = Buffer.alloc(64 * 1024 + 1)
  try {
    if (cli === 'grok') {
      assertGrokNativeEnvironment(home)
      const directory = join(home, '.grok')
      const info = await lstat(directory)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(directory)) !== join(await realpath(home), '.grok')
      )
        throw new Error('Invalid account directory')
    }
    const location = await lstat(path)
    if (location.isSymbolicLink() || !location.isFile()) throw new Error('Invalid account file')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.dev !== location.dev || info.ino !== location.ino || info.nlink !== 1 || info.size > 64 * 1024 || !info.size)
      throw new Error('Invalid account file')
    let offset = 0
    while (offset < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > 64 * 1024) throw new Error('Account file too large')
    const current = await lstat(path)
    const after = await file.stat()
    if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('Account file changed during read')
    const raw: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8'))
    signal.throwIfAborted()
    let username = 'unknown'
    try {
      username = userInfo().username
    } catch {
      /* native fallback */
    }
    const identity =
      cli === 'grok'
        ? projectGrokIdentity(raw)
        : projectZCodeIdentity(
            raw,
            (options.credentialSecret ?? process.env.ZCODE_CREDENTIAL_SECRET?.trim()) ||
              `zcode-credential-fallback:${platform()}:${homedir()}:${username}`,
          )
    return cli === 'zcode' && identity.state === 'unconfigured'
      ? readZCodePersonalIdentity(
          zcodeAuthDirectory(config.zcodeAuthDirectory, storageRoot(config, home)),
          options.home ? { nativeHome: home } : {},
        )
      : identity
  } catch (error) {
    signal.throwIfAborted()
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? cli === 'zcode'
        ? readZCodePersonalIdentity(
            zcodeAuthDirectory(config.zcodeAuthDirectory, storageRoot(config, home)),
            options.home ? { nativeHome: home } : {},
          )
        : { state: 'unconfigured', verification: 'local', summary: '尚未登录' }
      : { state: 'unavailable', verification: 'local', summary: '登录配置读取失败，请重试' }
  } finally {
    buffer.fill(0)
    await file?.close()
  }
}

const entryArgv = (executable: string) =>
  /\.[cm]?js$/i.test(executable) ? [process.execPath, executable] : [executable]

/** The two installed 0.16.9 builds differ; version strings alone are not a capability check. */
export function supportsBigModelLogin(help: string): boolean {
  return /^\s*login\s+\[zai\|bigmodel\]/m.test(stripVTControlCharacters(help))
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('账号目录必须是独立的本地目录')
  await chmod(path, 0o700)
  return path
}

async function zcodeHelp(
  executable: string,
  cwd: string,
  backend: ProcessBackend,
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const control = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  const child = backend.spawn({
    argv: [...entryArgv(executable), '--help'],
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: config.graceMs,
    signal: control,
  })
  void child.done.catch(() => undefined)
  let output = '',
    bytes = 0
  const read = async (stream: typeof child.stdout, keep: boolean) => {
    if (!stream) return
    const decoder = new StringDecoder('utf8')
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > 64 * 1024) throw new Error('CLI help too large')
      if (keep) output += decoder.write(buffer)
    }
    if (keep) output += decoder.end()
  }
  const readers = [read(child.stdout, true), read(child.stderr, false)]
  for (const reader of readers) void reader.catch(() => undefined)
  let cancel: () => void = () => undefined
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('CLI help cancelled'))
    control.addEventListener('abort', cancel, { once: true })
    if (control.aborted) cancel()
  })
  try {
    const [outcome] = await Promise.race([Promise.all([child.done, ...readers]), cancelled])
    control.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error('CLI help failed')
    return output
  } catch {
    signal.throwIfAborted()
    throw new ZCodeAccountCapabilityError('无法确认 ZCode 账号功能，请检查完整 CLI 安装后重试')
  } finally {
    control.removeEventListener('abort', cancel)
    child.terminate()
    if (!(await child.waitForExit())) throw new Error('ZCode 能力检查进程未完成清理')
    await Promise.allSettled([child.done, ...readers])
    output = ''
  }
}

/** Build a user-operated terminal spec. Never starts login or injects terminal input. */
export async function zcodeGrokAccountLaunch(
  cli: ZCodeGrokCli,
  action: AccountAction,
  executable: string,
  config: RuntimeConfig,
  backend: ProcessBackend,
  signal: AbortSignal,
  options: { home?: string } = {},
): Promise<ZCodeGrokAccountLaunch> {
  signal.throwIfAborted()
  const home = options.home ?? homedir()
  const root = storageRoot(config, home)
  const state = await privateDirectory(join(root, 'accounts', `${cli}-terminal`))
  // Native ZCode auth commands load .env from cwd/ancestors. Explicit auth/config
  // variables take precedence; a private empty cwd avoids loading the user's project.
  const cwd = await privateDirectory(join(state, 'workspace'))
  if (cli === 'grok') {
    signal.throwIfAborted()
    return {
      argv: privateArgv([executable, ...(action === 'manage' ? [] : [action])]),
      env: { GROK_HOME: join(home, '.grok'), ELECTRON_RUN_AS_NODE: '1' },
      cwd,
      instruction: zcodeGrokInstruction(cli, action),
    }
  }
  const help = await zcodeHelp(executable, cwd, backend, config, signal)
  if (!supportsBigModelLogin(help))
    throw new ZCodeAccountCapabilityError(
      '当前 ZCode 是不含完整 BigModel 登录与终端界面的桌面内置版。请配置支持 login [zai|bigmodel] 的完整 ZCode CLI。',
    )
  const auth = await privateDirectory(zcodeAuthDirectory(config.zcodeAuthDirectory, root))
  const env = {
    ...zcodeEnvironment(executable, state, auth, config.zcodeBuiltinConfig),
    ELECTRON_RUN_AS_NODE: '1',
  }
  signal.throwIfAborted()
  return {
    argv: privateArgv([
      ...entryArgv(executable),
      ...(action === 'manage' ? ['tui'] : action === 'login' ? ['login', 'bigmodel'] : ['logout']),
    ]),
    env,
    cwd,
    instruction: zcodeGrokInstruction(cli, action),
  }
}
