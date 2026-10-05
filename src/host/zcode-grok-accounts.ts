import { chmod, lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { AccountAction } from '../shared/accounts.ts'
import type { AccountIdentity } from './account-identity.ts'
import type { ProcessBackend, RuntimeConfig } from './process.ts'
import { zcodeAuthDirectory, zcodeEnvironment } from './zcode-adapter.ts'

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
    return '在 ZCode 原生终端输入 /login 或 /logout 管理独立账号；插件不会代你输入。'
  }
  if (action === 'login') return '按 Grok 原生提示完成浏览器授权；使用 Grok 本机账号，插件任务读取同一账号。'
  if (action === 'logout') return '按 Grok 原生流程退出本机账号；其他使用该 Grok 账号的终端也将受到影响。'
  return '在 Grok 原生终端管理账号；终端输入仅由你直接操作。'
}

function storageRoot(config: RuntimeConfig, home: string): string {
  return config.stateDirectory ?? join(process.env.DSH_HOME ?? join(home, '.dsh'), 'cliworker-now')
}

/** No credential is opened/decoded here. File presence is only local configuration evidence. */
export async function zcodeGrokAccountStatus(
  cli: ZCodeGrokCli,
  config: RuntimeConfig,
  signal: AbortSignal,
  options: { home?: string } = {},
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
  try {
    const info = await lstat(path)
    signal.throwIfAborted()
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0)
      return { state: 'unknown', verification: 'local', summary: '本地账号文件不可确认，请在账号终端检查' }
    return {
      state: 'configured',
      verification: 'local',
      summary: '检测到本地账号文件；登录有效性与账号信息请在原生 CLI 确认',
    }
  } catch (error) {
    signal.throwIfAborted()
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'unknown', verification: 'local', summary: '尚未发现本地账号文件，可打开账号终端登录' }
      : { state: 'unknown', verification: 'local', summary: '暂时无法读取本地账号状态，可打开账号终端检查' }
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
