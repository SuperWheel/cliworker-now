import { lstatSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
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
import { inspectPiOmpNativeAccount } from './pi-omp-native.ts'
import { inspectOpenCodeProfile, type OpenCodeNativeOptions } from './opencode-native.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

async function managedIdentity(config: RuntimeConfig, signal: AbortSignal): Promise<AccountIdentity> {
  signal.throwIfAborted()
  if (!config.zaiCredentialRef) return { state: 'unconfigured', summary: '尚未配置备用 API' }
  let key: string | undefined
  try {
    key = await config.resolveCredential?.(config.zaiCredentialRef)
  } catch {
    signal.throwIfAborted()
    return { state: 'unavailable', summary: '备用 API 读取失败，请检查宿主设置' }
  }
  signal.throwIfAborted()
  return key
    ? {
        state: 'configured',
        authMethod: 'api',
        verification: 'local',
        summary: '已配置备用 API',
      }
    : { state: 'unavailable', summary: '备用 API 不可用，请检查宿主设置' }
}

export async function readPiOmpAccount(
  cli: 'pi' | 'omp',
  config: RuntimeConfig,
  signal: AbortSignal,
  options: { nativeHome?: string } = {},
): Promise<AccountIdentity> {
  const native = await inspectPiOmpNativeAccount(cli, config.stateDirectory, signal, options)
  return withManagedSource(native, config, signal)
}

/** A Host API reference is an additional execution source, never a native login. */
async function withManagedSource(
  native: AccountIdentity,
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<AccountIdentity> {
  if (!config.zaiCredentialRef) return native
  const managed = await managedIdentity(config, signal)
  return {
    ...native,
    summary: `${native.summary}；${
      managed.state === 'configured' ? '已配置备用 API' : '备用 API 不可用，请检查宿主设置'
    }`,
  }
}

/** Project only capability metadata, never keys, arbitrary provider metadata or token claims. */
export async function readOpenCodeAccount(
  config: RuntimeConfig,
  signal: AbortSignal,
  options: OpenCodeNativeOptions = {},
): Promise<AccountIdentity> {
  signal.throwIfAborted()
  const native = await inspectOpenCodeProfile(openCodeAuthDirectory(config.stateDirectory), {
    ...options,
    signal,
  })
  return withManagedSource(native, config, signal)
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
