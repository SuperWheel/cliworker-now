import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountAction, AccountSource } from '../shared/accounts.ts'
import { accountEmail, localTokenExpired, type AccountIdentity } from './account-identity.ts'
import type { AccountLogin } from '../shared/accounts.ts'
import { authenticatedAccountLogins, providerLogin, usableNativeApiKey } from './account-login.ts'
import { hermesSourceSuppressed, projectHermesUnsuppressedAuth } from './hermes-suppression.ts'
import { projectHermesNousSource } from './hermes-nous.ts'
import { parseHermesOwnEnvironment } from './hermes-env.ts'
import { confineExtended, privateDirectory } from './extended-adapters.ts'
import { assertHermesOwnAccounts } from './hermes-models.ts'
import { hermesHomeDirectory } from './hermes-adapter.ts'
import {
  effectiveHermesHome,
  prepareHermesAccountHome,
  hermesAccountEnvironment,
} from './hermes-account-context.ts'
import { hermesNativeCommand, hermesCommandInstallationHome } from './hermes-installation.ts'
import { hermesRuntimePolicy } from './hermes-sandbox.ts'
import { hermesAccountIsolationPolicy } from './hermes-account-isolation.ts'
import { projectDirectory, type RuntimeConfig } from './process.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const configured = (authMethod?: 'oauth' | 'api'): AccountIdentity => ({
  state: 'configured',
  verification: 'local',
  ...(authMethod ? { authMethod } : {}),
  summary: '已配置 Hermes 账号',
})

/** Only the display email from the native OAuth ID token is projected, never token text.
 * This is local metadata, not signature validation or a remote login assertion.
 */
function tokenEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32 * 1024) return
  const pieces = value.split('.')
  if (pieces.length !== 3 || pieces.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return
  const buffer = Buffer.from(pieces[1]!, 'base64url')
  try {
    const claims: unknown = JSON.parse(buffer.toString('utf8'))
    return record(claims) ? accountEmail(claims.email) : undefined
  } catch {
    return
  } finally {
    buffer.fill(0)
  }
}

/** Native shapes from auth_codex.py/auth_xai.py and NousResearch/hermes-agent@6c80c327 auth_nous.py.
 * Explicit own credentials project local login; provider declarations and unknown schemas do not.
 */
export function projectHermesIdentity(raw: unknown): AccountIdentity | undefined {
  if (!record(raw)) throw new Error('Invalid Hermes auth metadata')
  raw = projectHermesUnsuppressedAuth(raw)
  if (!record(raw)) throw new Error('Invalid Hermes auth metadata')
  const providers = record(raw.providers) ? raw.providers : {}
  const ids = nonempty(raw.active_provider) ? [raw.active_provider] : Object.keys(providers)
  const logins: AccountLogin[] = []
  let expired = false
  for (const id of ids) {
    const state = providers[id]
    if (id === 'nous' && record(state)) {
      try {
        const nous = projectHermesNousSource(raw)
        logins.push({
          ...providerLogin('nous', 'oauth'),
          ...(nous.email ? { accountLabel: nous.email } : {}),
        })
      } catch (error) {
        if (error instanceof Error && /过期/.test(error.message)) expired = true
      }
      continue
    }
    if (!record(state) || !record(state.tokens)) continue
    const tokens = state.tokens
    const recognized =
      (id === 'openai-codex' && state.auth_mode === 'chatgpt') ||
      (id === 'xai-oauth' && ['oauth_device_code', 'oauth_pkce'].includes(String(state.auth_mode)))
    if (
      !recognized ||
      !usableNativeApiKey(state.tokens.access_token) ||
      state.disabled === true ||
      (record(state.last_auth_error) && state.last_auth_error.relogin_required === true)
    )
      continue
    const entries = record(raw.credential_pool) ? raw.credential_pool[id] : undefined
    if (
      entries !== undefined &&
      (!Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !record(entry) ||
            entry.auth_type !== 'oauth' ||
            ![
              'device_code',
              'manual:device_code',
              ...(id === 'openai-codex' ? ['manual:loopback_pkce'] : []),
            ].includes(String(entry.source)) ||
            entry.access_token !== tokens.access_token ||
            entry.disabled === true ||
            ['dead', 'exhausted'].includes(String(entry.last_status)),
        ))
    )
      continue
    if (localTokenExpired(state.tokens.access_token)) {
      expired = true
      continue
    }
    const email = tokenEmail(state.tokens.id_token)
    logins.push({
      ...providerLogin(id === 'xai-oauth' ? 'xai' : id, 'oauth'),
      ...(email ? { accountLabel: email } : {}),
    })
  }
  const pools = record(raw.credential_pool) ? raw.credential_pool : {}
  for (const [provider, entries] of Object.entries(pools)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (
        !record(entry) ||
        entry.auth_type !== 'api_key' ||
        entry.disabled === true ||
        ['dead', 'exhausted'].includes(String(entry.last_status)) ||
        entry.status === 'exhausted' ||
        !['manual', 'config', ...(provider === 'openrouter' ? ['manual:openrouter_pkce'] : [])].includes(
          String(entry.source ?? 'manual'),
        ) ||
        !usableNativeApiKey(entry.access_token ?? entry.runtime_api_key)
      )
        continue
      logins.push(providerLogin(provider, 'api', { baseUrl: entry.base_url }))
    }
  }
  if (logins.length) {
    const identity = authenticatedAccountLogins(logins)
    const only = identity.logins?.length === 1 ? identity.logins[0] : undefined
    return { ...identity, ...(only?.accountLabel ? { accountLabel: only.accountLabel } : {}) }
  }
  if (expired)
    return {
      state: 'unauthenticated',
      verification: 'local',
      authMethod: 'oauth',
      summary: '登录已过期，请重新登录',
    }
  // Do not choose an arbitrary identity when several providers are configured.
  const pool = record(raw.credential_pool) ? Object.values(raw.credential_pool).flat() : []
  const api = pool.some(
    (entry) =>
      record(entry) &&
      entry.auth_type === 'api_key' &&
      (nonempty(entry.access_token) || nonempty(entry.runtime_api_key)),
  )
  if (Object.keys(providers).length || pool.length) return configured(api ? 'api' : undefined)
  return undefined
}

async function environmentLogins(path: string, signal: AbortSignal, auth: unknown): Promise<AccountLogin[]> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  const buffer = Buffer.alloc(64 * 1024 + 1)
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024)
      throw new Error('Unsafe Hermes environment')
    let length = 0
    while (length < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > 64 * 1024) throw new Error('Oversized Hermes environment')
    // Default generated config.yaml and commented .env templates do not prove an account exists.
    // Only explicit provider API-key assignments count; values never leave this local boolean check.
    const env = parseHermesOwnEnvironment(buffer.subarray(0, length).toString('utf8'))
    return Object.entries(env).flatMap(([name, value]) => {
      const match =
        /^(OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE|GROQ|MISTRAL|DEEPSEEK|XAI|ZAI|KIMI|MINIMAX|NOUS)_API_KEY(?:_\d+)?$/.exec(
          name,
        )
      if (!match || !usableNativeApiKey(value)) return []
      const provider = ['GEMINI', 'GOOGLE'].includes(match[1]!)
        ? 'google'
        : match[1] === 'KIMI'
          ? 'kimi-coding'
          : match[1]!.toLowerCase()
      return hermesSourceSuppressed(auth, provider, `env:${name}`) ? [] : [providerLogin(provider, 'api')]
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  } finally {
    buffer.fill(0)
    await file?.close()
  }
}

export async function readHermesAccount(
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<AccountIdentity> {
  signal.throwIfAborted()
  let file: Awaited<ReturnType<typeof open>> | undefined
  let identity: AccountIdentity | undefined
  let auth: unknown = {}
  const buffer = Buffer.alloc(64 * 1024 + 1)
  try {
    const home = effectiveHermesHome(config)
    const info = await lstat(home)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe Hermes home')
    try {
      file = await open(
        join(home, 'auth.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024)
        throw new Error('Unsafe Hermes auth file')
      let length = 0
      while (length < buffer.length) {
        signal.throwIfAborted()
        const result = await file.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > 64 * 1024) throw new Error('Oversized Hermes auth file')
      auth = JSON.parse(buffer.subarray(0, length).toString('utf8'))
      identity = projectHermesIdentity(auth)
      signal.throwIfAborted()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const envLogins = await environmentLogins(join(home, '.env'), signal, auth)
    if (envLogins.length) return authenticatedAccountLogins([...(identity?.logins ?? []), ...envLogins])
    return (
      identity ?? {
        state: 'unconfigured',
        verification: 'local',
        summary: '尚未配置 Hermes 账号',
      }
    )
  } catch (error) {
    signal.throwIfAborted()
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'unconfigured', verification: 'local', summary: '尚未配置 Hermes 账号' }
      : {
          state: 'unavailable',
          verification: 'local',
          summary: '账号配置读取失败，请检查配置',
        }
  } finally {
    buffer.fill(0)
    await file?.close()
  }
}

export async function listHermesAccountSources(config: RuntimeConfig, signal: AbortSignal) {
  const status = await readHermesAccount(config, signal)
  if (!['authenticated', 'configured', 'unauthenticated'].includes(status.state)) return []
  const plugin = resolve(
    config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
    'accounts',
    'hermes',
  )
  const id: AccountSource = effectiveHermesHome(config) === plugin ? 'plugin' : 'native'
  return [{ id, label: id === 'plugin' ? '插件账号' : 'CLI 全局账号' }]
}

/** Native auth remove writes only these account files, not installation or history. */
export function hermesLogoutPolicy(home: string): string {
  const literal = (name: string) => `(literal ${JSON.stringify(join(home, name))})`
  if (/[\x00-\x1f\x7f]/.test(home)) throw new Error('Unsafe Hermes home')
  const regex = (pattern: string) => '#"' + pattern.replace(/"/g, '\\"') + '"'
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    `\n(deny network*)\n(allow file-write-mode (literal ${JSON.stringify(home)}))\n` +
    `(allow file-write* ${['auth.json', 'auth.lock', '.env', '.env.lock', '.anthropic_oauth.json'].map(literal).join(' ')} ` +
    `(regex ${regex(`^${escaped}/[.]auth_[^/]+[.]tmp$`)}) (regex ${regex(`^${escaped}/[.]env_[^/]+[.]tmp$`)}))\n`
  )
}

export async function prepareHermesAccount(
  action: AccountAction,
  executable: string,
  project: string,
  config: RuntimeConfig,
  signal: AbortSignal,
  source?: AccountSource,
): Promise<{
  argv: string[]
  cwd: string
  env: Record<string, string>
  instruction: string
  cleanup: () => Promise<void>
}> {
  signal.throwIfAborted()
  if (!['login', 'manage', 'logout'].includes(action)) throw new Error('不支持的 Hermes 账号操作')
  if (!nonempty(executable) || executable.includes('\0')) throw new Error('Invalid Hermes executable')
  projectDirectory(project)
  let sourceLabel = ''
  if (action === 'logout') {
    const sources = await listHermesAccountSources(config, signal)
    const chosen = source ? sources.find((item) => item.id === source) : sources[0]
    if (!chosen) throw new Error('账号来源已变化，请刷新后重试')
    sourceLabel = chosen.label
  }
  const home = action === 'logout' ? effectiveHermesHome(config) : prepareHermesAccountHome(config)
  await assertHermesOwnAccounts(home, signal)
  const userHome = await realpath(homedir())
  if (home === sep || home === userHome || userHome.startsWith(home + sep))
    throw new Error('Unsafe Hermes home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const homeInfo = await lstat(home)
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('Unsafe Hermes home')
  const nativeHome = await realpath(home)
  if (nativeHome === sep || nativeHome === userHome || userHome.startsWith(nativeHome + sep))
    throw new Error('Unsafe Hermes home')
  const root = privateDirectory(
    resolve(config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now')),
  )
  const parent = privateDirectory(join(root, 'account-runtime'))
  const state = await mkdtemp(join(parent, 'hermes-'))
  const identity = await lstat(state)
  const parentIdentity = await lstat(parent)
  let removed = false
  const cleanup = async () => {
    if (removed) return
    const parentNow = await lstat(parent)
    if (
      parentNow.isSymbolicLink() ||
      parentNow.dev !== parentIdentity.dev ||
      parentNow.ino !== parentIdentity.ino
    )
      throw new Error('Hermes account runtime parent changed before cleanup')
    try {
      const now = await lstat(state)
      if (now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino)
        throw new Error('Hermes account runtime changed before cleanup')
      await rm(state, { recursive: true, force: true })
      removed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') removed = true
      else throw error
    }
  }
  try {
    signal.throwIfAborted()
    const temporary = privateDirectory(join(state, 'tmp'))
    const command = await hermesNativeCommand(executable, [action === 'login' ? 'model' : 'auth'], signal)
    const argv = confineExtended(
      [process.execPath, fileURLToPath(new URL('./private-launch.mjs', import.meta.url)), ...command],
      state,
      state,
      'plan',
      temporary,
      action === 'logout' ? undefined : nativeHome,
    )
    argv[2] += hermesRuntimePolicy(
      hermesCommandInstallationHome(command) ?? hermesHomeDirectory(config.hermesHome),
    )
    argv[2] += hermesAccountIsolationPolicy(nativeHome, state, [hermesHomeDirectory(config.hermesHome)])
    if (action === 'logout') argv[2] += hermesLogoutPolicy(nativeHome)
    return {
      argv,
      cwd: state,
      env: {
        ...hermesAccountEnvironment(nativeHome),
        TMPDIR: temporary,
        HERMES_SAFE_MODE: '1',
        HERMES_IGNORE_RULES: '1',
        HERMES_YOLO_MODE: '0',
        HERMES_ACCEPT_HOOKS: '0',
        PYTHONDONTWRITEBYTECODE: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
      instruction:
        action === 'logout'
          ? `${sourceLabel}：选择 Remove a credential，再选择服务商和凭据；其他来源保留。`
          : action === 'login'
            ? '在 Hermes 原生菜单中选择服务商并登录。'
            : '在 Hermes 原生账号菜单中管理凭据；更改保存在插件的 Hermes 账号目录，终端输入仅由你直接操作。',
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
