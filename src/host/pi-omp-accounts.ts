import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialEnvironment } from './extended-adapters.ts'
import type { AccountAction } from '../shared/accounts.ts'
import type { PiOmpCli } from './pi-omp-adapter.ts'
import { projectDirectory, type RuntimeConfig } from './process.ts'

export interface PiOmpAccountTerminalInput {
  cli: PiOmpCli
  action?: AccountAction
  executable: string
  project: string
  stateDirectory: string
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

async function withCancellation<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) {
    void pending.catch(() => undefined)
    signal.throwIfAborted()
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * User-operated native login UI, or a management TUI for the worker CN route.
 * Neither path sends a prompt. Login does not change the worker credential route.
 */
export async function preparePiOmpAccountTerminal(
  input: PiOmpAccountTerminalInput,
): Promise<PiOmpAccountTerminalLaunch> {
  const { cli, config, signal } = input
  if (cli !== 'pi' && cli !== 'omp') throw new Error('Unsupported Pi/OMP account terminal')
  signal?.throwIfAborted()
  projectDirectory(input.project)
  let credentials: Record<string, string>
  try {
    credentials =
      input.action === 'login' ? {} : await withCancellation(credentialEnvironment(cli, config), signal)
  } catch {
    signal?.throwIfAborted()
    throw new Error('无法读取智谱凭据，请在 Harness 模型设置中检查当前凭据引用')
  }
  signal?.throwIfAborted()
  if (input.action !== 'login' && !credentials.ZAI_CODING_CN_API_KEY)
    throw new Error('请先在 Harness 模型设置中配置当前智谱凭据；原生 OAuth 登录不能替代此 API 路由')

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
    const temporary = await privateDirectory(join(runtime, 'tmp'))
    const provider = cli === 'pi' ? 'zai-coding-cn' : 'cliworker-zai-cn'
    const nativeArgs = [
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--provider',
      provider,
      '--model',
      'glm-5.3-flash',
      '--thinking',
      'low',
    ]
    const env: Record<string, string> = {
      ...credentials,
      PI_CODING_AGENT_DIR: agent,
      TMPDIR: temporary,
      ELECTRON_RUN_AS_NODE: '1',
      // Do not let a caller's active profile redirect this disposable TUI to
      // another credential store. Harness already scrubs ambient secret names.
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
      // OMP accepts models.yml; JSON is a YAML subset. This is the exact custom
      // provider shape used by pi-omp-bridge.mjs, without writing the resolved key.
      await writePrivateJSON(join(agent, 'models.yml'), {
        providers: {
          [provider]: {
            api: 'openai-completions',
            baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            apiKey: 'ZAI_CODING_CN_API_KEY',
            models: [
              {
                id: 'glm-5.3-flash',
                name: 'GLM-5.3-Flash',
                reasoning: true,
                input: ['text', 'image'],
                contextWindow: 1000000,
                maxTokens: 131072,
                cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
                thinking: { mode: 'effort', efforts: ['low', 'high', 'max'], defaultLevel: 'low' },
                compat: {
                  supportsStore: false,
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: true,
                  maxTokensField: 'max_tokens',
                  thinkingFormat: 'zai',
                  supportsStrictMode: true,
                },
              },
            ],
          },
        },
      })
      await writePrivateJSON(join(agent, 'config.yml'), {
        // Native OMP 16.4.4 setup scene selection reads startup.setupWizard.
        // Each account runtime is fresh, but its API provider is already supplied
        // by Harness; do not show an unrelated OAuth onboarding wizard.
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
      argv: [
        process.execPath,
        fileURLToPath(new URL('./private-launch.mjs', import.meta.url)),
        ...nativeArgv,
      ],
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
