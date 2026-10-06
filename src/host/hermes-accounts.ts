import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountAction } from '../shared/accounts.ts'
import { accountEmail, type AccountIdentity } from './account-identity.ts'
import { confineExtended, privateDirectory } from './extended-adapters.ts'
import { hermesHomeDirectory } from './hermes-adapter.ts'
import { projectDirectory, type RuntimeConfig } from './process.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const configured = (authMethod?: 'oauth' | 'api'): AccountIdentity => ({
  state: 'configured',
  verification: 'local',
  ...(authMethod ? { authMethod } : {}),
  summary: '已发现 Hermes 本地配置，可在账号终端查看登录详情',
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

/** Native shapes pinned to NousResearch/hermes-agent@4787e4d auth_codex.py/auth_xai.py.
 * Provider configurations and unrecognized credential pools remain merely configured.
 */
export function projectHermesIdentity(raw: unknown): AccountIdentity | undefined {
  if (!record(raw)) throw new Error('Invalid Hermes auth metadata')
  const providers = record(raw.providers) ? raw.providers : {}
  const ids = nonempty(raw.active_provider) ? [raw.active_provider] : Object.keys(providers)
  const identities: AccountIdentity[] = []
  for (const id of ids) {
    const state = providers[id]
    if (!record(state) || !record(state.tokens)) continue
    const recognized =
      (id === 'openai-codex' && state.auth_mode === 'chatgpt') ||
      (id === 'xai-oauth' && ['oauth_device_code', 'oauth_pkce'].includes(String(state.auth_mode)))
    if (!recognized || !nonempty(state.tokens.access_token) || !nonempty(state.tokens.refresh_token)) continue
    const email = tokenEmail(state.tokens.id_token)
    if (email)
      identities.push({
        state: 'authenticated',
        authMethod: 'oauth',
        accountLabel: email,
        verification: 'local',
        summary: '已读取 Hermes 本地 OAuth 登录会话',
      })
  }
  if (identities.length === 1) return identities[0]
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

async function environmentCredentialPresent(path: string, signal: AbortSignal): Promise<boolean> {
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
    return buffer
      .subarray(0, length)
      .toString('utf8')
      .split(/\r?\n/)
      .some((line) => {
        const match =
          /^\s*(?:export\s+)?(?:OPENROUTER|OPENAI|ANTHROPIC|GEMINI|GOOGLE|GROQ|MISTRAL|DEEPSEEK|XAI|ZAI|KIMI|MINIMAX|NOUS)_API_KEY\s*=\s*(.*?)\s*$/.exec(
            line,
          )
        if (!match) return false
        const value = match[1]!
          .replace(/\s+#.*$/, '')
          .replace(/^(['"])(.*)\1$/, '$2')
          .trim()
        return !!value && !/^(?:your[_ -]|<|\$\{|placeholder|changeme)/i.test(value)
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
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
  const buffer = Buffer.alloc(64 * 1024 + 1)
  try {
    const home = hermesHomeDirectory(config.hermesHome)
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
      const identity = projectHermesIdentity(JSON.parse(buffer.subarray(0, length).toString('utf8')))
      signal.throwIfAborted()
      if (identity) return identity
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const present = await environmentCredentialPresent(join(home, '.env'), signal)
    return present
      ? configured('api')
      : {
          state: 'unauthenticated',
          verification: 'local',
          summary: '尚未配置 Hermes 登录，可打开登录设置',
        }
  } catch (error) {
    signal.throwIfAborted()
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'unauthenticated', verification: 'local', summary: '尚未配置 Hermes 登录，可打开登录设置' }
      : { state: 'unknown', verification: 'local', summary: '暂时无法确认 Hermes 本地账号，请在账号终端检查' }
  } finally {
    buffer.fill(0)
    await file?.close()
  }
}

export async function prepareHermesAccount(
  action: AccountAction,
  executable: string,
  project: string,
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<{
  argv: string[]
  cwd: string
  env: Record<string, string>
  instruction: string
  cleanup: () => Promise<void>
}> {
  signal.throwIfAborted()
  if (action !== 'login' && action !== 'manage') throw new Error('Hermes 账号终端不提供全局退出操作')
  if (!nonempty(executable) || executable.includes('\0')) throw new Error('Invalid Hermes executable')
  projectDirectory(project)
  const home = hermesHomeDirectory(config.hermesHome)
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
    return {
      argv: confineExtended(
        [
          process.execPath,
          fileURLToPath(new URL('./private-launch.mjs', import.meta.url)),
          executable,
          action === 'login' ? 'model' : 'auth',
        ],
        state,
        state,
        'plan',
        temporary,
        nativeHome,
      ),
      cwd: state,
      env: {
        HERMES_HOME: nativeHome,
        TMPDIR: temporary,
        HERMES_SAFE_MODE: '1',
        HERMES_IGNORE_RULES: '1',
        HERMES_YOLO_MODE: '0',
        HERMES_ACCEPT_HOOKS: '0',
        PYTHONDONTWRITEBYTECODE: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
      instruction:
        action === 'login'
          ? '在 Hermes 原生菜单中选择服务商并登录；插件不会代你提交凭据或发送任务。'
          : '在 Hermes 原生账号菜单中管理凭据；更改与本机 Hermes 共用，终端输入仅由你直接操作。',
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
