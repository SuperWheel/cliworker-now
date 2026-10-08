import { isExtendedCli } from './extended-adapters.ts'
import { firstPartyEnvironment, MimoConfigurationError } from './first-party-models.ts'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { executableFor, resolveCliExecutable } from './adapters.ts'
import {
  projectDirectory,
  ProcessCleanupUnconfirmedError,
  type ProcessBackend,
  type RuntimeConfig,
} from './process.ts'
import { CLI_IDS, type CliId } from '../shared/types.ts'
import type { AccountAction, AccountFrame, AccountStatus } from '../shared/accounts.ts'
import {
  accountEmail,
  localAccountIdentity,
  type AccountIdentity,
  type AccountIdentitySource,
} from './account-identity.ts'
import { readCodexAccount } from './codex-account.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  zcodeGrokAccountLaunch,
  zcodeGrokAccountStatus,
  zcodeGrokInstruction,
  ZCodeAccountCapabilityError,
} from './zcode-grok-accounts.ts'
import { readPiOmpAccount, readOpenCodeAccount, prepareOpenCodeAccount } from './harness-opencode-accounts.ts'
import { prepareHermesAccount, readHermesAccount } from './hermes-accounts.ts'
import { verifyHermesExecutable, HermesExecutableError } from './hermes-installation.ts'
import { preparePiOmpAccountTerminal } from './pi-omp-accounts.ts'
import { readKimiAccount, KIMI_MANAGE_LOGIN, prepareKimiAccountDirectory } from './kimi-accounts.ts'
import { readMimoAccount } from './mimo-configuration.ts'
import { prepareMimoAccountTerminal } from './first-party-account-context.ts'

const STATUS_TIMEOUT = 10_000
const STARTUP_TIMEOUT = 30_000
const TERMINAL_TIMEOUT = 30 * 60_000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_FRAMES = 512
const MAX_INPUT_BYTES = 16 * 1024
const ACTIONS: AccountAction[] = ['login', 'logout', 'manage']

const validateCli = (cli: CliId) => {
  if (!(CLI_IDS as readonly string[]).includes(cli)) throw new Error('不支持的 CLI')
}
const instructionFor = (cli: CliId, action: AccountAction): string => {
  if (cli === 'zcode' || cli === 'grok') return zcodeGrokInstruction(cli, action)
  if (cli === 'antigravity')
    return action === 'manage'
      ? '在 Antigravity 原生终端中使用 /login 登录，或 /logout 退出。'
      : `在 Antigravity 原生终端中输入 /${action} 并按 Enter。`
  if (cli === 'kimi' && action !== 'login')
    return action === 'logout'
      ? '在 Kimi 原生终端中输入 /logout 并按 Enter，再选择要退出的提供商。'
      : '在 Kimi 原生终端中使用 /login 或 /logout 管理提供商与账号。'
  if (action === 'manage') return '在原生 CLI 中管理账号。'
  return action === 'login'
    ? '按 CLI 原生提示完成登录；需要浏览器授权时由 CLI 打开浏览器。'
    : '按 CLI 原生流程退出登录。'
}
const actionsFor = (cli: CliId, config: RuntimeConfig): AccountStatus['actions'] => {
  if (cli === 'pi' || cli === 'omp' || cli === 'hermes')
    return [
      { id: 'login', label: '登录设置', description: '打开原生终端登录界面，选择提供商后由你完成授权。' },
      { id: 'manage', label: '账号终端', description: '打开原生终端管理账号。' },
    ]

  return ACTIONS.map((id) => ({
    id,
    label:
      id === 'login'
        ? cli === 'opencode' || cli === 'kimi'
          ? '登录设置'
          : '登录 / 切换账号'
        : id === 'logout'
          ? '退出登录'
          : '账号终端',
    description: instructionFor(cli, id),
  }))
}

/** Only commands verified against the installed CLIs. Never send a prompt/slash command. */
const argumentsFor = (cli: CliId, action: AccountAction): string[] => {
  if (cli === 'antigravity' || action === 'manage' || (cli === 'kimi' && action === 'logout')) return []
  if (cli === 'codex' || cli === 'kimi') return [action]
  return ['auth', action]
}

/** No raw command output, exception text, account tokens, or key prefixes cross this boundary. */
function summarize(cli: CliId, raw: string, exitCode: number | null): AccountIdentity {
  const text = stripVTControlCharacters(raw)
  if (
    exitCode !== 0 &&
    /\b(?:authentication failed|invalid (?:api key|credentials|token)|(?:credentials|token) (?:have |has )?expired|401\s+Unauthorized)\b/i.test(
      text,
    )
  )
    return { state: 'unauthenticated', summary: 'CLI 报告认证失效，请重新登录或检查凭据' }
  if (cli === 'codex') {
    if (exitCode === 0 && /\bLogged in using ChatGPT\b/.test(text))
      return {
        state: 'authenticated',
        summary: '已通过 ChatGPT 登录',
        authMethod: 'oauth',
        verification: 'cli',
      }
    if (exitCode === 0 && /\bLogged in using (?:an )?API key\b/i.test(text))
      return { state: 'authenticated', summary: 'API 登录', authMethod: 'api', verification: 'cli' }
    if (/^Not logged in\s*$/m.test(text)) return { state: 'unconfigured', summary: '尚未登录' }
  } else if (cli === 'claude') {
    try {
      const value = JSON.parse(text)
      if (value.loggedIn === false) return { state: 'unconfigured', summary: '尚未登录' }
      if (exitCode === 0 && value.loggedIn === true) {
        // Claude's installed auth/status implementation only returns email for
        // claude.ai sessions. Environment OAuth tokens do not identify an account.
        const oauth = value.authMethod === 'oauth_token' || value.authMethod === 'claude.ai'
        const api = value.authMethod === 'api_key' || value.authMethod === 'api_key_helper'
        return {
          state: 'authenticated',
          summary: api ? 'API 登录' : oauth ? '已通过 OAuth 登录' : 'CLI 报告已登录',
          authMethod: api ? 'api' : oauth ? 'oauth' : undefined,
          accountLabel: value.authMethod === 'claude.ai' ? accountEmail(value.email) : undefined,
          verification: 'cli',
        }
      }
    } catch {
      return { state: 'unavailable', summary: '账号状态响应无法解析，请在账号终端检查' }
    }
  } else if (cli === 'mimo') {
    if (exitCode === 0 && /Provider: MiMo\b/.test(text)) {
      // Installed whoami source emits User ID only in the type === 'api'
      // metadata branch. Never expose that metadata or a key prefix for API auth.
      if (/\bType:\s*api\b|\bUser ID:/.test(text))
        return {
          state: 'authenticated',
          summary: 'API 登录',
          authMethod: 'api',
          verification: 'local',
        }
      return { state: 'configured', summary: '已配置 MiMo 账号', verification: 'cli' }
    }
    if (/Not logged in\. Run `mimo auth login` to log in\./.test(text))
      return { state: 'unconfigured', summary: '尚未登录 MiMo' }
  }
  if (exitCode !== 0) return { state: 'unavailable', summary: 'CLI 账号状态查询失败，请在账号终端检查' }
  return { state: 'unknown', summary: '登录状态未知，请打开账号终端' }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

interface ParentScope {
  controller: AbortController
  pending: Set<Promise<unknown>>
}

interface StatusQuery {
  cli: CliId
  controller: AbortController
  operation: Promise<AccountStatus>
  subscribers: Set<{ signal: AbortSignal }>
  settled: boolean
}

interface AccountSession {
  id: string
  parent: string
  scope: ParentScope
  cli: CliId
  terminal: SubprocessTerminalHandle
  frames: AccountFrame[]
  bytes: number
  seq: number
  state: 'running' | 'closed' | 'failed'
  stopping: boolean
  changed: Set<() => void>
  output: Promise<void>
  cleanup?: Promise<void>
  release?: () => void | Promise<void>
  deadline?: ReturnType<typeof setTimeout>
  attachDeadline?: ReturnType<typeof setTimeout>
  expiry?: ReturnType<typeof setTimeout>
}

/** User-only auth processes. Only allowlisted identity metadata leaves the Host. */
export class AccountManager {
  private readonly sessions = new Map<string, AccountSession>()
  private readonly reserved = new Set<CliId>()
  private readonly unsafeQueries = new Set<CliId>()
  private readonly statusQueries = new Map<string, StatusQuery>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly parents = new Map<string, ParentScope>()
  private readonly parentClosings = new Map<string, Promise<void>>()
  private readonly controller = new AbortController()
  private closing?: Promise<void>

  constructor(
    private backend: ProcessBackend,
    private config: RuntimeConfig,
    private identity: AccountIdentitySource = localAccountIdentity(),
  ) {}

  isBusy(cli: CliId): boolean {
    validateCli(cli)
    return this.reserved.has(cli) || this.unsafeQueries.has(cli)
  }

  async status(cli: CliId, cwd: string, signal: AbortSignal): Promise<AccountStatus> {
    validateCli(cli)
    if (signal.aborted || this.controller.signal.aborted) throw new Error('账号状态查询已取消')
    const directory = projectDirectory(cwd)
    const key = JSON.stringify([cli, directory])
    let query = this.statusQueries.get(key)
    if (query && [...query.subscribers].every((reader) => reader.signal.aborted)) query.controller.abort()
    // The abandoned process still owns cleanup; a new reader must not overlap it.
    if (query?.controller.signal.aborted) {
      await abortable(
        query.operation.catch(() => undefined),
        signal,
      )
      return this.status(cli, directory, signal)
    }
    if (!query) {
      const controller = new AbortController()
      query = {
        cli,
        controller,
        operation: this.track(this.readStatus(cli, directory, controller.signal)),
        subscribers: new Set(),
        settled: false,
      }
      this.statusQueries.set(key, query)
      const current = query
      void current.operation
        .finally(() => {
          current.settled = true
          if (this.statusQueries.get(key) === current) this.statusQueries.delete(key)
        })
        .catch(() => undefined)
    }
    const reader = { signal }
    query.subscribers.add(reader)
    try {
      // Share only the running read, never a completed login/authorization result.
      return await abortable(query.operation, signal)
    } catch (error) {
      if (signal.aborted) throw new Error('账号状态查询已取消')
      throw error
    } finally {
      query.subscribers.delete(reader)
      if (!query.subscribers.size && !query.settled) {
        query.controller.abort()
        await query.operation.catch(() => undefined)
      }
    }
  }

  private async readStatus(cli: CliId, cwd: string, signal: AbortSignal): Promise<AccountStatus> {
    if (this.unsafeQueries.has(cli))
      return {
        cli,
        installed: true,
        state: 'unavailable',
        summary: '账号查询未完成清理，请重启应用',
        actions: [],
      }
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), STATUS_TIMEOUT)
    timeout.unref?.()
    const control = AbortSignal.any([signal, this.controller.signal, timer.signal])
    let installed = false
    try {
      const executable = await resolveCliExecutable(cli, this.backend, this.config, control)
      installed = true
      control.throwIfAborted()
      if (cli === 'mimo')
        return {
          cli,
          installed,
          ...(await readMimoAccount(control)),
          actions: this.backend.spawnTerminal ? actionsFor(cli, this.config) : [],
        }
      if (cli === 'hermes') await verifyHermesExecutable(executable, control)
      if (isExtendedCli(cli)) {
        const identity = await abortable(
          cli === 'zcode' || cli === 'grok'
            ? zcodeGrokAccountStatus(cli, this.config, control)
            : cli === 'opencode'
              ? readOpenCodeAccount(this.config, control)
              : cli === 'hermes'
                ? readHermesAccount(this.config, control)
                : readPiOmpAccount(cli, this.config, control),
          control,
        )
        return {
          cli,
          installed,
          ...identity,
          actions: actionsFor(cli, this.config).filter(
            (item) => item.target === 'models' || this.backend.spawnTerminal,
          ),
        }
      }
      if (cli === 'antigravity') {
        const identity = await abortable(this.identity(cli, control), control)
        return {
          cli,
          installed,
          ...(identity ?? {
            state: 'unknown' as const,
            summary: '已安装，登录状态未知',
          }),
          actions: this.backend.spawnTerminal ? actionsFor(cli, this.config) : [],
        }
      }
      if (cli === 'codex') {
        // One effective-store read handles file/keyring accounts and display
        // identity. Older servers fall back to the native status command below.
        const identity = await readCodexAccount(this.backend, this.config, executable, cwd, control)
        if (identity)
          return {
            cli,
            installed,
            ...identity,
            actions: this.backend.spawnTerminal ? actionsFor(cli, this.config) : [],
          }
      }
      const argv =
        cli === 'codex'
          ? ['login', 'status']
          : cli === 'claude'
            ? ['auth', 'status', '--json']
            : cli === 'kimi'
              ? ['provider', 'list', '--json']
              : ['auth', 'whoami']
      const child = this.backend.spawn({
        argv: [executable, ...argv],
        env: firstPartyEnvironment(cli),
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.config.graceMs,
        signal: control,
      })
      void child.done.catch(() => undefined)
      let raw = '',
        bytes = 0
      const read = async (stream: typeof child.stdout) => {
        if (!stream) return
        const decoder = new StringDecoder('utf8')
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          bytes += buffer.byteLength
          if (bytes > 64 * 1024) throw new Error('状态响应超过限制')
          raw += decoder.write(buffer)
        }
        raw += decoder.end()
      }
      const readers = [read(child.stdout), read(child.stderr)]
      try {
        const [outcome] = await abortable(Promise.all([child.done, ...readers]), control)
        const status =
          cli === 'kimi' && outcome.exitCode === 0
            ? await readKimiAccount(raw, control)
            : summarize(cli, raw, outcome.exitCode)
        return {
          cli,
          installed,
          ...status,
          actions: this.backend.spawnTerminal
            ? actionsFor(cli, this.config).map((item) =>
                cli === 'kimi' && item.id === 'login' && status.state === 'authenticated'
                  ? { ...item, label: '管理登录', description: '在原生终端管理 Kimi 登录' }
                  : item,
              )
            : [],
        }
      } finally {
        try {
          child.terminate()
          if (!(await child.waitForExit())) throw new ProcessCleanupUnconfirmedError()
        } catch {
          throw new ProcessCleanupUnconfirmedError()
        }
        await Promise.allSettled([child.done, ...readers])
        raw = ''
      }
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) {
        this.unsafeQueries.add(cli)
        return {
          cli,
          installed,
          state: 'unavailable',
          summary: '账号查询未完成清理，请重启应用',
          actions: [],
        }
      }
      if (signal.aborted || this.controller.signal.aborted) throw new Error('账号状态查询已取消')
      const code = (error as NodeJS.ErrnoException)?.code
      if (error instanceof MimoConfigurationError)
        return { cli, installed, state: 'unavailable', summary: error.message, actions: [] }
      if (error instanceof HermesExecutableError)
        return { cli, installed, state: 'unavailable', summary: error.message, actions: [] }
      if (code === 'CLI_IDENTITY_MISMATCH')
        return {
          cli,
          installed: true,
          state: 'unavailable',
          summary: `${cli === 'omp' ? 'OMP' : 'Pi'} 执行入口身份不匹配，请检查该 CLI 的安装和路径`,
          actions: [],
        }
      const failed =
        installed ||
        this.hasCustomExecutable(cli) ||
        timer.signal.aborted ||
        (!!code && code !== 'ENOENT' && code !== 'ENOTDIR')
      return {
        cli,
        installed,
        state: failed ? 'unavailable' : 'unconfigured',
        summary: installed
          ? '账号状态暂不可用，可打开账号终端检查'
          : this.hasCustomExecutable(cli)
            ? 'CLI 执行路径配置失败，请检查可执行路径'
            : timer.signal.aborted
              ? 'CLI 安装探测超时，请刷新重试'
              : failed
                ? 'CLI 安装状态读取失败，请检查安装'
                : '尚未安装 CLI，请检查安装',
        actions: installed && this.backend.spawnTerminal ? actionsFor(cli, this.config) : [],
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private hasCustomExecutable(cli: CliId): boolean {
    if (cli === 'antigravity') return this.config.executable !== 'agy'
    if (cli === 'harness') return false
    const configured = this.config[`${cli}Executable`]
    return !!configured && configured !== cli
  }

  start(
    parent: string,
    cli: CliId,
    action: AccountAction,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ id: string; instruction: string }> {
    validateCli(cli)
    if (!ACTIONS.includes(action)) throw new Error('不支持的账号操作')
    if (!parent || parent.length > 512) throw new Error('无效的父会话')
    this.controller.signal.throwIfAborted()
    signal.throwIfAborted()
    const capability = actionsFor(cli, this.config).find((item) => item.id === action)
    if (!capability || capability.target === 'models')
      throw new Error('此版本 CLI 未提供终端登录或账号管理入口')
    if (!this.backend.spawnTerminal) throw new Error('当前宿主不支持交互终端')
    if (this.unsafeQueries.has(cli)) throw new ProcessCleanupUnconfirmedError()
    if (this.reserved.has(cli)) throw new Error('此 CLI 已有账号终端，请先关闭后重试')
    const directory = projectDirectory(cwd)
    this.reserved.add(cli)
    for (const query of this.statusQueries.values()) if (query.cli === cli) query.controller.abort()
    let scope = this.parents.get(parent)
    if (!scope) {
      scope = { controller: new AbortController(), pending: new Set() }
      this.parents.set(parent, scope)
    }
    const operation = this.track(this.startSession(parent, cli, action, directory, signal, scope))
    scope.pending.add(operation)
    void operation.finally(() => scope.pending.delete(operation)).catch(() => undefined)
    return operation
  }

  private async startSession(
    parent: string,
    cli: CliId,
    action: AccountAction,
    cwd: string,
    signal: AbortSignal,
    scope: ParentScope,
  ) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), STARTUP_TIMEOUT)
    timer.unref?.()
    const startup = AbortSignal.any([signal, scope.controller.signal, this.controller.signal, timeout.signal])
    // Provider cancellation belongs to allocation, not the interactive login's
    // lifetime. A completed login terminal must not inherit this request/timer.
    const allocationControl = new AbortController()
    const cancelAllocation = () => allocationControl.abort()
    startup.addEventListener('abort', cancelAllocation, { once: true })
    let session: AccountSession | undefined
    let allocation: Promise<AccountSession> | undefined
    let release: (() => void | Promise<void>) | undefined
    let instruction = instructionFor(cli, action)
    try {
      const executable = await resolveCliExecutable(cli, this.backend, this.config, startup)
      if (cli === 'hermes') await verifyHermesExecutable(executable, startup)
      startup.throwIfAborted()
      let launch: { argv: string[]; cwd: string; env?: Record<string, string> } = {
        argv: [executable, ...argumentsFor(cli, action)],
        env: firstPartyEnvironment(cli),
        cwd,
      }
      if (cli === 'kimi') {
        if (action === 'login') {
          const current = await this.readStatus(cli, cwd, startup)
          startup.throwIfAborted()
          if (current.state === 'authenticated' && current.authMethod === 'oauth') {
            launch.argv = [executable]
            instruction = KIMI_MANAGE_LOGIN
          }
        }
        const prepared = await prepareKimiAccountDirectory(
          this.config.stateDirectory ??
            join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
          startup,
        )
        launch.cwd = prepared.cwd
        release = prepared.cleanup
        if (action !== 'login') instruction = `若出现 Trust 提示，请自行确认此空账号目录；${instruction}`
      } else if (cli === 'mimo') {
        const prepared = await prepareMimoAccountTerminal(
          executable,
          action,
          this.config.stateDirectory ??
            join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
          startup,
        )
        launch = prepared
        release = prepared.cleanup
      } else if (cli === 'zcode' || cli === 'grok') {
        const prepared = await zcodeGrokAccountLaunch(
          cli,
          action,
          executable,
          this.config,
          this.backend,
          startup,
        )
        launch = prepared
        instruction = prepared.instruction
      } else if (cli === 'pi' || cli === 'omp') {
        const prepared = await preparePiOmpAccountTerminal({
          cli,
          action,
          executable,
          project: cwd,
          stateDirectory:
            this.config.stateDirectory ??
            join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
          config: this.config,
          signal: startup,
        })
        launch = prepared
        instruction = prepared.instruction
        release = prepared.cleanup
      } else if (cli === 'hermes') {
        const prepared = await prepareHermesAccount(action, executable, cwd, this.config, startup)
        launch = prepared
        instruction = prepared.instruction
        release = prepared.cleanup
      } else if (cli === 'opencode') {
        const prepared = await prepareOpenCodeAccount(executable, action, this.config, startup)
        launch = prepared
        instruction = prepared.instruction
        release = prepared.cleanup
      }
      startup.throwIfAborted()
      allocation = this.backend.spawnTerminal!({
        ...launch,
        rows: 24,
        cols: 80,
        terminalType: 'xterm-256color',
        graceMs: this.config.graceMs,
        signal: allocationControl.signal,
      }).then(
        async (terminal) => {
          void terminal.done.catch(() => undefined)
          session = {
            id: randomUUID(),
            parent,
            scope,
            cli,
            terminal,
            frames: [],
            bytes: 0,
            seq: 0,
            state: 'running',
            stopping: false,
            changed: new Set(),
            output: Promise.resolve(),
            release,
          }
          this.sessions.set(session.id, session)
          this.emit(session, { status: 'running' })
          session.output = this.readTerminal(session)
          void session.output.catch(() => undefined)
          // Even if an uncooperative provider ignores cancellation, a late PTY
          // is adopted and cleaned up before releasing its CLI reservation.
          if (startup.aborted) {
            await this.finish(session, 'closed', '启动已取消')
            startup.throwIfAborted()
          }
          return session
        },
        async (error) => {
          try {
            await release?.()
          } finally {
            this.reserved.delete(cli)
          }
          throw error
        },
      )
      this.track(allocation)
      scope.pending.add(allocation)
      const pendingAllocation = allocation
      void allocation.finally(() => scope.pending.delete(pendingAllocation)).catch(() => undefined)
      session = await abortable(allocation, startup)
      if (startup.aborted) {
        await this.finish(session, 'closed', '启动已取消')
        startup.throwIfAborted()
      }
      const published = session
      session.deadline = setTimeout(() => {
        void this.finish(published, 'closed', '账号终端已达到 30 分钟上限，请重新打开').catch(() => undefined)
      }, TERMINAL_TIMEOUT)
      session.deadline.unref?.()
      session.attachDeadline = setTimeout(() => {
        void this.finish(published, 'closed', '账号终端未连接，已自动关闭').catch(() => undefined)
      }, 30_000)
      session.attachDeadline.unref?.()
      void session.terminal.done
        .then(
          (outcome) =>
            this.finish(
              published,
              outcome.exitCode === 0 ? 'closed' : 'failed',
              outcome.exitCode === 0 ? '账号终端已结束' : '账号终端已退出，请查看 CLI 提示',
            ),
          () => this.finish(published, 'failed', '账号终端连接失败，请重新打开'),
        )
        .catch(() => undefined)
      return { id: session.id, instruction }
    } catch (error) {
      // An allocation still in flight may own a process already; never permit a
      // second login until its late handle/rejection establishes cleanup.
      if (!session && !allocation) {
        try {
          await release?.()
        } finally {
          this.reserved.delete(cli)
        }
      }
      if (session && startup.aborted && !session.cleanup)
        await this.finish(session, 'closed', '启动已取消').catch(() => undefined)
      if (error instanceof Error && error.message === '此 CLI 已有账号终端，请先关闭后重试') throw error
      if (timeout.signal.aborted) throw new Error('账号终端启动超时，正在回收启动过程；请稍后重试')
      if (error instanceof ZCodeAccountCapabilityError) throw error
      if (error instanceof HermesExecutableError) throw error
      if (error instanceof MimoConfigurationError) throw error
      if ((error as NodeJS.ErrnoException)?.code === 'CLI_IDENTITY_MISMATCH')
        throw new Error(`${cli === 'omp' ? 'OMP' : 'Pi'} 执行入口身份不匹配，请检查该 CLI 的安装和路径`)
      throw new Error(
        session || startup.aborted
          ? '账号终端启动已取消或清理失败，请关闭设置后重试'
          : '无法启动账号终端，请检查 CLI 安装',
      )
    } finally {
      clearTimeout(timer)
      startup.removeEventListener('abort', cancelAllocation)
    }
  }

  private async readTerminal(session: AccountSession): Promise<void> {
    const decoder = new StringDecoder('utf8')
    try {
      for await (const chunk of session.terminal.output) {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
        for (let offset = 0; offset < text.length; offset += 4096)
          this.emit(session, { data: text.slice(offset, offset + 4096) })
      }
      const tail = decoder.end()
      if (tail) this.emit(session, { data: tail })
    } catch {
      // Do not await from this reader: finish waits for the reader to settle.
      void this.finish(session, 'failed', '账号终端输出中断，请重新打开').catch(() => undefined)
    }
  }

  private emit(session: AccountSession, frame: Omit<AccountFrame, 'seq'>) {
    const entry = { ...frame, seq: ++session.seq }
    session.frames.push(entry)
    session.bytes += Buffer.byteLength(entry.data ?? '')
    while (session.bytes > MAX_OUTPUT_BYTES || session.frames.length > MAX_FRAMES) {
      const removed = session.frames.shift()!
      session.bytes -= Buffer.byteLength(removed.data ?? '')
    }
    for (const notify of session.changed) notify()
    session.changed.clear()
  }

  private owned(parent: string, id: string): AccountSession {
    const session = this.sessions.get(id)
    if (!session || session.parent !== parent) throw new Error('账号终端不存在或不属于当前会话')
    return session
  }

  async *watch(parent: string, id: string, signal: AbortSignal): AsyncIterable<AccountFrame> {
    const session = this.owned(parent, id)
    clearTimeout(session.attachDeadline)
    let seq = 0
    try {
      while (!signal.aborted) {
        const frames = session.frames.filter((frame) => frame.seq > seq)
        if (frames.length && frames[0].seq > seq + 1)
          yield { seq: frames[0].seq - 1, message: '较早的终端输出已从内存释放' }
        for (const frame of frames) {
          seq = frame.seq
          yield frame
        }
        if (session.state !== 'running' || signal.aborted) return
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener('abort', wake)
            session.changed.delete(wake)
            resolve()
          }
          session.changed.add(wake)
          signal.addEventListener('abort', wake, { once: true })
          if (signal.aborted || session.seq > seq || session.state !== 'running') wake()
        })
      }
    } finally {
      if (session.state === 'running') await this.finish(session, 'closed', '账号终端连接已关闭')
    }
  }

  async write(parent: string, id: string, data: string): Promise<void> {
    const session = this.owned(parent, id)
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES)
      throw new Error('单次终端输入超过限制')
    if (session.state !== 'running' || session.stopping) throw new Error('账号终端已关闭')
    try {
      await session.terminal.write(data)
    } catch {
      throw new Error('无法写入账号终端，请重新打开')
    }
  }

  async resize(parent: string, id: string, cols: number, rows: number): Promise<void> {
    const session = this.owned(parent, id)
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 10 ||
      cols > 500 ||
      rows < 5 ||
      rows > 200
    )
      throw new Error('无效的终端尺寸')
    if (session.state !== 'running' || session.stopping) return
    try {
      await session.terminal.resize(cols, rows)
    } catch {
      throw new Error('无法调整账号终端尺寸，请重新打开')
    }
  }

  async stop(parent: string, id: string): Promise<void> {
    await this.finish(this.owned(parent, id), 'closed', '账号终端已关闭')
  }

  /** Close one Agent lifetime, including startup; a later Agent with the same ID gets a fresh scope. */
  closeParent(parent: string): Promise<void> {
    const scope = this.parents.get(parent)
    const previous = this.parentClosings.get(parent)
    if (!scope && previous) return previous
    if (scope) {
      this.parents.delete(parent)
      scope.controller.abort()
    }
    // Capture this generation before yielding. Never close a newly reactivated
    // parent merely because its ID equals the one whose disposal is in flight.
    const captured = [...this.sessions.values()].filter(
      (session) =>
        session.parent === parent && (!scope || session.scope === scope || session.state === 'failed'),
    )
    const operation = (async () => {
      await Promise.allSettled(scope ? [...scope.pending] : [])
      const owned = new Set(captured)
      if (scope) for (const session of this.sessions.values()) if (session.scope === scope) owned.add(session)
      const cleanup = [...owned].map(async (session) => {
        await this.finish(session, 'closed', '主会话已关闭')
        clearTimeout(session.expiry)
        session.frames.length = 0
        this.sessions.delete(session.id)
      })
      if (previous) cleanup.push(previous)
      const results = await Promise.allSettled(cleanup)
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('此主会话的账号终端尚未确认完全退出')
    })()
    this.parentClosings.set(parent, operation)
    void operation
      .finally(() => {
        if (this.parentClosings.get(parent) === operation) this.parentClosings.delete(parent)
      })
      .catch(() => undefined)
    return operation
  }

  private finish(session: AccountSession, state: 'closed' | 'failed', message: string): Promise<void> {
    if (session.cleanup) return session.cleanup
    session.stopping = true
    clearTimeout(session.deadline)
    clearTimeout(session.attachDeadline)
    session.cleanup = (async () => {
      try {
        await session.terminal.terminate()
        await session.output
        await session.release?.()
        session.state = state
        this.emit(session, { status: state, message })
        this.reserved.delete(session.cli)
        session.expiry = setTimeout(() => {
          session.frames.length = 0
          this.sessions.delete(session.id)
        }, 60_000)
        session.expiry.unref?.()
        const retained = [...this.sessions.values()].filter((item) => item.expiry !== undefined)
        for (const stale of retained.slice(0, Math.max(0, retained.length - 16))) {
          clearTimeout(stale.expiry)
          stale.frames.length = 0
          this.sessions.delete(stale.id)
        }
      } catch {
        session.state = 'failed'
        this.emit(session, { status: 'failed', message: '账号终端清理失败，请重试关闭' })
        session.cleanup = undefined
        throw new Error('账号终端尚未确认完全退出')
      }
    })()
    return session.cleanup
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined)
    return operation
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.controller.abort()
    this.closing = (async () => {
      await Promise.allSettled([...this.pending])
      await Promise.allSettled([...this.parentClosings.values()])
      const results = await Promise.allSettled(
        [...this.sessions.values()].map((session) => this.finish(session, 'closed', '插件已关闭')),
      )
      for (const session of this.sessions.values()) {
        clearTimeout(session.deadline)
        clearTimeout(session.attachDeadline)
        clearTimeout(session.expiry)
        session.frames.length = 0
      }
      const failures = results.filter((result) => result.status === 'rejected')
      if (failures.length) throw new Error('部分账号终端尚未确认完全退出')
      this.sessions.clear()
      this.reserved.clear()
      this.parents.clear()
    })()
    return this.closing
  }
}
