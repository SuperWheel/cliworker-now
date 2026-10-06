import { constants, lstatSync, rmSync } from 'node:fs'
import { lstat, open, mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountAction } from '../shared/accounts.ts'
import type { AccountIdentity } from './account-identity.ts'
import type { RuntimeConfig } from './process.ts'
import {
  openCodeAuthDirectory,
  openCodeCredentialEnvironment,
  openCodeEnvironment,
} from './opencode-adapter.ts'
import { confineExtended, privateDirectory } from './extended-adapters.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

async function managedIdentity(config: RuntimeConfig, signal: AbortSignal): Promise<AccountIdentity> {
  signal.throwIfAborted()
  if (!config.zaiCredentialRef)
    return { state: 'unauthenticated', summary: '请在 Harness 原生模型设置中配置提供商凭据' }
  let key: string | undefined
  try {
    key = await config.resolveCredential?.(config.zaiCredentialRef)
  } catch {
    signal.throwIfAborted()
    return { state: 'unknown', summary: '暂时无法读取 Harness 凭据引用' }
  }
  signal.throwIfAborted()
  return key
    ? {
        state: 'configured',
        authMethod: 'api',
        verification: 'local',
        summary: 'API 凭据由 Harness 原生模型设置管理；未进行远程验证',
      }
    : { state: 'unauthenticated', summary: 'Harness 凭据引用尚未配置，请打开原生模型设置' }
}

export const readPiOmpAccount = managedIdentity

/** Project only capability metadata, never keys, arbitrary provider metadata or token claims. */
export async function readOpenCodeAccount(
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<AccountIdentity> {
  if (config.zaiCredentialRef) return managedIdentity(config, signal)
  signal.throwIfAborted()
  const data = openCodeAuthDirectory(config.stateDirectory)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Do not follow a planted credential file or the two owned directory entries.
    for (const path of [data, join(data, 'opencode')]) {
      const info = await lstat(path)
      signal.throwIfAborted()
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe auth directory')
    }
    file = await open(
      join(data, 'opencode', 'auth.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) throw new Error('Unsafe auth file')
    // Read at most the cap even if a concurrent writer grows the file after stat.
    const buffer = Buffer.alloc(64 * 1024 + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length)
      signal.throwIfAborted()
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > 64 * 1024) throw new Error('Unsafe auth file')
    const raw: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    signal.throwIfAborted()
    if (!record(raw)) throw new Error('Invalid auth data')
    const kinds = new Set<'api' | 'oauth'>()
    for (const value of Object.values(raw)) {
      if (!record(value)) continue
      if (value.type === 'api' && typeof value.key === 'string' && value.key.trim()) kinds.add('api')
      if (
        value.type === 'oauth' &&
        typeof value.access === 'string' &&
        value.access &&
        typeof value.refresh === 'string' &&
        value.refresh &&
        typeof value.expires === 'number' &&
        Number.isFinite(value.expires)
      )
        kinds.add('oauth')
    }
    if (kinds.size)
      return {
        state: 'configured',
        verification: 'local',
        ...(kinds.size === 1 ? { authMethod: [...kinds][0]! } : {}),
        summary: '已配置 OpenCode 原生凭据；未进行远程验证',
      }
    return Object.keys(raw).length
      ? { state: 'unknown', summary: '原生凭据格式无法确认，请在账号终端检查', verification: 'local' }
      : { state: 'unauthenticated', summary: '尚未配置 OpenCode 原生凭据' }
  } catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { state: 'unauthenticated', summary: '尚未配置 OpenCode 原生凭据' }
    return { state: 'unknown', summary: '暂时无法确认 OpenCode 本地凭据，请在账号终端检查' }
  } finally {
    await file?.close()
  }
}

async function withCancellation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    signal.throwIfAborted()
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

/** User-operated native terminal. No task prompt, slash command, login or logout is injected. */
export async function prepareOpenCodeAccount(
  executable: string,
  action: AccountAction,
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<{
  argv: string[]
  env: Record<string, string>
  cwd: string
  cleanup: () => void
  instruction: string
}> {
  signal.throwIfAborted()
  if (!['login', 'logout', 'manage'].includes(action)) throw new Error('不支持的 OpenCode 账号操作')
  // Resolve before allocating disk state, and release a cancelled startup even if
  // an unavailable credential provider never settles its original request.
  const credentials = await withCancellation(
    action === 'manage' ? openCodeCredentialEnvironment(config) : Promise.resolve({}),
    signal,
  )
  signal.throwIfAborted()
  const data = openCodeAuthDirectory(config.stateDirectory)
  const accountRoot = privateDirectory(dirname(data))
  const terminals = privateDirectory(join(accountRoot, 'terminals'))
  const state = privateDirectory(await mkdtemp(join(terminals, 'terminal-')))
  const identity = lstatSync(state)
  const parentIdentity = lstatSync(terminals)
  let removed = false
  const cleanup = () => {
    if (removed) return
    const parent = lstatSync(terminals)
    if (parent.isSymbolicLink() || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino)
      throw new Error('OpenCode account runtime parent changed before cleanup')
    let current
    try {
      current = lstatSync(state)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        removed = true
        return
      }
      throw error
    }
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error('OpenCode account runtime changed before cleanup')
    // rm does not follow nested links. Never seal/chmod or remove the shared auth tree.
    rmSync(state, { recursive: true, force: true })
    removed = true
  }
  try {
    signal.throwIfAborted()
    const env = await openCodeEnvironment(
      state,
      {
        permission: { '*': 'deny' },
        ...(config.zaiCredentialRef && action === 'manage'
          ? {
              model: 'zhipuai-coding-plan/glm-5.3-flash',
              small_model: 'zhipuai-coding-plan/glm-5.3-flash',
              enabled_providers: ['zhipuai-coding-plan'],
            }
          : {}),
      },
      data,
      !!config.zaiCredentialRef && action === 'manage',
    )
    signal.throwIfAborted()
    const argv = [executable, ...(action === 'manage' ? [] : ['auth', action])]
    return {
      argv: confineExtended(
        [process.execPath, fileURLToPath(new URL('./private-launch.mjs', import.meta.url)), ...argv],
        state,
        state,
        'plan',
        undefined,
        data,
      ),
      env: { ...env, ...credentials, ELECTRON_RUN_AS_NODE: '1' },
      cwd: state,
      cleanup,
      instruction:
        config.zaiCredentialRef && action === 'manage'
          ? '当前 API 凭据由 Harness 原生模型设置管理；此终端沿用任务的同一凭据，账号切换请使用原生模型设置。'
          : action === 'manage'
            ? '在 OpenCode 原生终端使用 /connect 管理登录；凭据与插件任务共用，工作数据保持独立。'
            : '按 OpenCode 原生账号流程操作；凭据与插件任务共用，关闭终端不会撤销已完成的账号操作。',
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
