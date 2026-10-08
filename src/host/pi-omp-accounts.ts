import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapshotPiOmpNative, safePiOmpAncestors } from './pi-omp-native.ts'
import { confineExtended } from './extended-adapters.ts'
import type { AccountAction } from '../shared/accounts.ts'
import type { PiOmpCli } from './pi-omp-adapter.ts'
import { projectDirectory, type RuntimeConfig } from './process.ts'

export interface PiOmpAccountTerminalInput {
  cli: PiOmpCli
  action?: AccountAction
  executable: string
  project: string
  stateDirectory: string
  /** Read-only native source override for isolated integrations/tests. */
  nativeHome?: string
  config: RuntimeConfig
  signal?: AbortSignal
}
export interface PiOmpAccountTerminalLaunch {
  argv: string[]
  cwd: string
  env: Record<string, string>
  instruction: string
  /** Call only after the complete terminal process range has exited. */
  cleanup: () => Promise<void>
}

async function privateDirectory(path: string) {
  await safePiOmpAncestors(path)
  await mkdir(path, { recursive: true, mode: 0o700 })
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('Unsafe account directory symlink')
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error('Account directory changed while opening')
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
  return realpath(path)
}

async function writePrivateJSON(path: string, value: unknown) {
  const temporary = `${path}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * User-operated native account UI. No task prompt or automatic login is sent;
 * original global sources remain unchanged and this plugin keeps its own account store.
 */
export async function preparePiOmpAccountTerminal(
  input: PiOmpAccountTerminalInput,
): Promise<PiOmpAccountTerminalLaunch> {
  const { cli, signal } = input
  if (cli !== 'pi' && cli !== 'omp') throw new Error('Unsupported Pi/OMP account terminal')
  signal?.throwIfAborted()
  projectDirectory(input.project)
  const root = await privateDirectory(resolve(input.stateDirectory))
  const accountRoot = await privateDirectory(join(root, 'account-runtime'))
  const runtime = await mkdtemp(join(accountRoot, `${cli}-`))
  const identity = await lstat(runtime)
  let removed = false
  const cleanup = async () => {
    if (removed) return
    let current
    try {
      current = await lstat(runtime)
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        removed = true
        return
      }
      throw error
    }
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error('Account runtime changed before cleanup')
    await rm(runtime, { recursive: true, force: true })
    removed = true
  }
  try {
    signal?.throwIfAborted()
    const accounts = await privateDirectory(join(root, 'accounts'))
    const account = await privateDirectory(join(accounts, cli))
    const agent = await privateDirectory(join(account, 'agent'))
    const native = await snapshotPiOmpNative(cli, agent, { accountRoot: root, nativeHome: input.nativeHome })
    const temporary = await privateDirectory(join(runtime, 'tmp'))
    const nativeArgs = ['--no-session', '--no-tools', '--no-extensions', '--no-skills']
    const env: Record<string, string> = {
      ...native.env,
      PI_CODING_AGENT_DIR: agent,
      TMPDIR: temporary,
      ELECTRON_RUN_AS_NODE: '1',
      // Do not let a caller's active profile redirect this disposable TUI to
      // another credential store. Harness already scrubs ambient secret names.
      OMP_AUTH_BROKER_URL: '',
      OMP_AUTH_BROKER_TOKEN: '',
      OMP_PROFILE: '',
      PI_PROFILE: '',
    }
    if (cli === 'pi') {
      nativeArgs.push(
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--no-approve',
        '--offline',
      )
      env.PI_OFFLINE = '1'
      env.PI_TELEMETRY = '0'
    } else {
      const nativeAuth = JSON.parse(await readFile(join(agent, 'native-auth.json'), 'utf8'))
      await writePrivateJSON(join(agent, 'config.yml'), {
        ...nativeAuth,
        // Native OMP 16.4.4 setup scene selection reads startup.setupWizard.
        // Account login is an explicit action; manage does not start onboarding.
        startup: { setupWizard: false, showSplash: false, checkUpdate: false },
        // OMP 16.4.4 has no --no-mcp. Its native discovery registry filters these
        // provider IDs before reading global/project MCP files or spawning servers.
        // Account terminals must not import other applications' tools or hooks.
        disabledProviders: [
          'native',
          'claude',
          'claude-plugins',
          'codex',
          'cursor',
          'gemini',
          'opencode',
          'mcp-json',
          'vscode',
          'windsurf',
          'omp-plugins',
        ],
        mcp: { enableProjectConfig: false },
        retry: { modelFallback: false },
        memory: { backend: 'off' },
        tools: { approvalMode: 'always-ask' },
      })
      env.PI_CONFIG_DIR = relative(homedir(), account)
      nativeArgs.push(
        '--no-rules',
        '--no-title',
        '--no-lsp',
        '--no-pty',
        '--approval-mode',
        'always-ask',
        '--config',
        join(agent, 'config.yml'),
      )
    }
    signal?.throwIfAborted()
    let nativeArgv = /\.[cm]?js$/.test(input.executable)
      ? [process.execPath, input.executable, ...nativeArgs]
      : [input.executable, ...nativeArgs]
    if (input.action === 'login') {
      // No prompt injection: OMP's native onboarding, or Pi's native UI API.
      nativeArgv =
        cli === 'omp'
          ? [input.executable, 'setup']
          : [process.execPath, fileURLToPath(new URL('./pi-login.mjs', import.meta.url)), input.executable]
    }
    return {
      argv: confineExtended(
        [process.execPath, fileURLToPath(new URL('./private-launch.mjs', import.meta.url)), ...nativeArgv],
        runtime,
        runtime,
        'plan',
        undefined,
        agent,
        true,
      ),
      // Avoid loading project files while operating account controls.
      cwd: runtime,
      env,
      instruction:
        input.action === 'login'
          ? '在原生登录界面选择提供商并完成授权；关闭终端会保留已登录的账号。'
          : '输入 /login 或 /logout 管理终端账号；现有任务保留已选择的模型与凭据。',
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
