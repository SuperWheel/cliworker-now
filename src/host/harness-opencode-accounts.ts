import { lstatSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountAction } from '../shared/accounts.ts'
import type { AccountIdentity } from './account-identity.ts'
import type { RuntimeConfig } from './process.ts'
import { openCodeAuthDirectory, openCodeEnvironment } from './opencode-adapter.ts'
import { confineExtended, privateDirectory } from './extended-adapters.ts'
import { inspectPiOmpNativeAccount } from './pi-omp-native.ts'
import {
  assertOpenCodeManagedAuth,
  inspectOpenCodeProfile,
  type OpenCodeNativeOptions,
} from './opencode-native.ts'

export async function readPiOmpAccount(
  cli: 'pi' | 'omp',
  config: RuntimeConfig,
  signal: AbortSignal,
  options: { nativeHome?: string } = {},
): Promise<AccountIdentity> {
  const native = await inspectPiOmpNativeAccount(cli, config.stateDirectory, signal, options)
  return native
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
  return native
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
    await assertOpenCodeManagedAuth(data, signal)
    const env = await openCodeEnvironment(
      state,
      {
        permission: { '*': 'deny' },
      },
      data,
      false,
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
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: state,
      cleanup,
      instruction:
        action === 'manage'
          ? '在 OpenCode 原生终端使用 /connect 管理登录；凭据与插件任务共用，工作数据保持独立。'
          : '按 OpenCode 原生账号流程操作；凭据与插件任务共用，关闭终端不会撤销已完成的账号操作。',
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
