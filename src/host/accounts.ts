import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { executableFor } from './adapters.ts'
import { projectDirectory, type ProcessBackend, type RuntimeConfig } from './process.ts'
import { CLI_IDS, type CliId } from '../shared/types.ts'
import type { AccountAction, AccountFrame, AccountStatus } from '../shared/accounts.ts'

const STATUS_TIMEOUT = 10_000
const TERMINAL_TIMEOUT = 30 * 60_000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_FRAMES = 512
const MAX_INPUT_BYTES = 16 * 1024
const ACTIONS: AccountAction[] = ['login', 'logout', 'manage']

const validateCli = (cli: CliId) => {
  if (!CLI_IDS.includes(cli)) throw new Error('不支持的 CLI')
}
const instructionFor = (cli: CliId, action: AccountAction): string => {
  if (cli === 'antigravity')
    return action === 'manage'
      ? '在 Antigravity 原生终端中使用 /login 登录，或 /logout 退出。'
      : `在 Antigravity 原生终端中输入 /${action} 并按 Enter；插件不会代你输入。`
  if (cli === 'kimi' && action !== 'login')
    return action === 'logout'
      ? '在 Kimi 原生终端中输入 /logout 并按 Enter，再选择要退出的提供商。'
      : '在 Kimi 原生终端中使用 /login 或 /logout 管理提供商与账号。'
  if (action === 'manage') return '在原生 CLI 中管理账号；终端输入仅由你直接操作。'
  return action === 'login'
    ? '按 CLI 原生提示完成登录；需要浏览器授权时由 CLI 打开浏览器。'
    : '按 CLI 原生流程退出登录；关闭终端不会恢复已退出的账号。'
}
const actionsFor = (cli: CliId): AccountStatus['actions'] =>
  ACTIONS.map((id) => ({
    id,
    label: id === 'login' ? '登录 / 切换账号' : id === 'logout' ? '退出登录' : '账号终端',
    description: instructionFor(cli, id),
  }))

/** Only commands verified against the installed CLIs. Never send a prompt/slash command. */
const argumentsFor = (cli: CliId, action: AccountAction): string[] => {
  if (cli === 'antigravity' || action === 'manage' || (cli === 'kimi' && action === 'logout')) return []
  if (cli === 'codex' || cli === 'kimi') return [action]
  return ['auth', action]
}

/** No raw command output, exception text, account tokens, or key prefixes cross this boundary. */
function summarize(
  cli: CliId,
  raw: string,
  exitCode: number | null,
): Pick<AccountStatus, 'state' | 'summary'> {
  const text = stripVTControlCharacters(raw)
  if (cli === 'codex') {
    if (exitCode === 0 && /\bLogged in using ChatGPT\b/.test(text))
      return { state: 'authenticated', summary: '已通过 ChatGPT 登录' }
    if (exitCode === 0 && /\bLogged in using (?:an )?API key\b/i.test(text))
      return { state: 'authenticated', summary: '已使用 API Key 登录' }
    if (/^Not logged in\s*$/m.test(text)) return { state: 'unauthenticated', summary: '尚未登录' }
  } else if (cli === 'claude') {
    try {
      const value = JSON.parse(text)
      if (value.loggedIn === false) return { state: 'unauthenticated', summary: '尚未登录' }
      if (exitCode === 0 && value.loggedIn === true) {
        const method =
          value.authMethod === 'oauth_token' ? 'OAuth' : value.authMethod === 'api_key' ? 'API Key' : ''
        return { state: 'authenticated', summary: method ? `已通过 ${method} 登录` : '已登录' }
      }
    } catch {
      /* Unknown output is not evidence of logout. */
    }
  } else if (cli === 'kimi') {
    // The non-JSON command prints only IDs/type/model counts/source. Configuration
    // existence does not validate a cached token; never label this authenticated.
    if (exitCode === 0 && /^\S+\s+type=\S+\s+models=\d+\s+source=oauth\s*$/m.test(text))
      return { state: 'configured', summary: '已配置 OAuth 提供商；登录有效性请在 CLI 内确认' }
    if (exitCode === 0 && /^\S+\s+type=\S+\s+models=\d+\s+source=\S+\s*$/m.test(text))
      return { state: 'configured', summary: '已配置提供商；可在账号终端管理' }
    if (exitCode === 0 && /^No providers configured\.\s*$/m.test(text))
      return { state: 'unauthenticated', summary: '尚未配置提供商' }
  } else if (cli === 'mimo') {
    if (exitCode === 0 && /Provider: MiMo\b/.test(text))
      return { state: 'configured', summary: '已配置 MiMo 凭据；账号详情可在原生终端查看' }
    if (/Not logged in\. Run `mimo auth login` to log in\./.test(text))
      return { state: 'unauthenticated', summary: '尚未登录 MiMo' }
  }
  return { state: 'unknown', summary: '暂时无法确认登录状态，可打开账号终端检查' }
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
  deadline?: ReturnType<typeof setTimeout>
  attachDeadline?: ReturnType<typeof setTimeout>
  expiry?: ReturnType<typeof setTimeout>
}

/** User-only auth processes. No credentials are read from disk or persisted by this manager. */
export class AccountManager {
  private readonly sessions = new Map<string, AccountSession>()
  private readonly reserved = new Set<CliId>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly parents = new Map<string, ParentScope>()
  private readonly parentClosings = new Map<string, Promise<void>>()
  private readonly controller = new AbortController()
  private closing?: Promise<void>

  constructor(
    private backend: ProcessBackend,
    private config: RuntimeConfig,
  ) {}

  isBusy(cli: CliId): boolean {
    validateCli(cli)
    return this.reserved.has(cli)
  }

  async status(cli: CliId, cwd: string, signal: AbortSignal): Promise<AccountStatus> {
    validateCli(cli)
    const operation = this.readStatus(cli, projectDirectory(cwd), signal)
    return this.track(operation)
  }

  private async readStatus(cli: CliId, cwd: string, signal: AbortSignal): Promise<AccountStatus> {
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), STATUS_TIMEOUT)
    timeout.unref?.()
    const control = AbortSignal.any([signal, this.controller.signal, timer.signal])
    let installed = false
    try {
      const executable = await abortable(
        this.backend.resolveExecutable(executableFor(cli, this.config)),
        control,
      )
      installed = true
      control.throwIfAborted()
      if (cli === 'antigravity')
        return {
          cli,
          installed,
          state: 'unknown',
          summary: 'CLI 已安装；请在原生账号终端查看和管理登录',
          actions: this.backend.spawnTerminal ? actionsFor(cli) : [],
        }
      const argv =
        cli === 'codex'
          ? ['login', 'status']
          : cli === 'claude'
            ? ['auth', 'status', '--json']
            : cli === 'kimi'
              ? ['provider', 'list']
              : ['auth', 'whoami']
      const child = this.backend.spawn({
        argv: [executable, ...argv],
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
        return {
          cli,
          installed,
          ...summarize(cli, raw, outcome.exitCode),
          actions: this.backend.spawnTerminal ? actionsFor(cli) : [],
        }
      } finally {
        child.terminate()
        await child.waitForExit()
        await Promise.allSettled([child.done, ...readers])
        raw = ''
      }
    } catch {
      if (signal.aborted || this.controller.signal.aborted) throw new Error('账号状态查询已取消')
      return {
        cli,
        installed,
        state: 'unavailable',
        summary: installed
          ? '账号状态暂不可用，可打开账号终端检查'
          : '无法找到或读取 CLI，请检查安装和可执行路径',
        actions: installed && this.backend.spawnTerminal ? actionsFor(cli) : [],
      }
    } finally {
      clearTimeout(timeout)
    }
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
    if (!this.backend.spawnTerminal) throw new Error('当前宿主不支持交互终端')
    if (this.reserved.has(cli)) throw new Error('此 CLI 已有账号终端，请先关闭后重试')
    const directory = projectDirectory(cwd)
    this.reserved.add(cli)
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
    const startup = AbortSignal.any([
      signal,
      scope.controller.signal,
      this.controller.signal,
      AbortSignal.timeout(30_000),
    ])
    let session: AccountSession | undefined
    try {
      const executable = await abortable(
        this.backend.resolveExecutable(executableFor(cli, this.config)),
        startup,
      )
      startup.throwIfAborted()
      const terminal = await this.backend.spawnTerminal!({
        argv: [executable, ...argumentsFor(cli, action)],
        cwd,
        rows: 24,
        cols: 80,
        terminalType: 'xterm-256color',
        graceMs: this.config.graceMs,
        signal: startup,
      })
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
      }
      this.sessions.set(session.id, session)
      this.emit(session, { status: 'running' })
      session.output = this.readTerminal(session)
      void session.output.catch(() => undefined)
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
      void terminal.done
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
      return { id: session.id, instruction: instructionFor(cli, action) }
    } catch (error) {
      if (!session) this.reserved.delete(cli)
      if (error instanceof Error && error.message === '此 CLI 已有账号终端，请先关闭后重试') throw error
      throw new Error(
        session ? '账号终端启动已取消或清理失败，请关闭设置后重试' : '无法启动账号终端，请检查 CLI 安装',
      )
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
