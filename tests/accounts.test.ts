import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { AccountManager } from '../src/host/accounts.ts'
import { DEFAULT_CONFIG, type ProcessBackend, type RuntimeConfig } from '../src/host/process.ts'
import type { CliId } from '../src/shared/types.ts'
import type { AccountIdentitySource } from '../src/host/account-identity.ts'

vi.mock('../src/host/pi-omp-identity.ts', () => ({
  verifyPiOmpExecutable: async (_cli: string, executable: string) => executable,
}))
vi.mock('../src/host/hermes-installation.ts', async (load) => ({
  ...(await load<typeof import('../src/host/hermes-installation.ts')>()),
  verifyHermesExecutable: async () => {},
}))

vi.mock('../src/host/zcode-grok-accounts.ts', async (load) => ({
  ...(await load<typeof import('../src/host/zcode-grok-accounts.ts')>()),
  zcodeGrokAccountStatus: async () => ({
    state: 'unconfigured',
    verification: 'local',
    summary: 'Synthetic fixture',
  }),
}))

// This suite exercises the account manager and simulated PTYs, never personal
// global credentials. Native configuration parsing is covered by native fixtures.
vi.mock('../src/host/pi-omp-native.ts', async (load) => {
  const actual = await load<typeof import('../src/host/pi-omp-native.ts')>()
  return {
    ...actual,
    snapshotPiOmpNative: (cli: 'pi' | 'omp', destination: string, options: { accountRoot?: string } = {}) =>
      actual.snapshotPiOmpNative(cli, destination, {
        ...options,
        nativeHome: dirname(options.accountRoot ?? destination),
      }),
    inspectPiOmpNativeAccount: async () => ({
      state: 'unconfigured',
      verification: 'local',
      summary: 'Synthetic native account fixture',
    }),
  }
})

// All subprocesses in this suite are synthetic. No real login/logout is run.
const roots: string[] = []
const managers: AccountManager[] = []
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(overrides: Partial<RuntimeConfig> = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-account-test-')))
  roots.push(cwd)
  vi.stubEnv('MIMOCODE_HOME', join(cwd, 'mimo'))
  const output = new PassThrough()
  const result = deferred<SubprocessOutcome>()
  const cleanup = deferred<void>()
  let waitCleanup = false
  const terminal: SubprocessTerminalHandle = {
    pid: 123,
    output,
    done: result.promise,
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    inspectForeground: async () => undefined,
    inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
    signalForeground: async () => 123,
    terminate: vi.fn(async () => {
      if (waitCleanup) await cleanup.promise
      output.end()
      result.resolve({ exitCode: 0, signal: null })
    }),
  }
  let raw = '',
    exitCode = 0
  let codexAccount: unknown
  const statusProcesses: SubprocessHandle[] = []
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async (name) => (name.startsWith('/') ? name : `/synthetic/${name}`)),
    spawnTerminal: vi.fn(async () => terminal),
    spawn: vi.fn((spec) => {
      const appServer = spec.argv.includes('app-server')
      const child: SubprocessHandle = {
        stdin: appServer
          ? new Writable({
              write(_chunk, _encoding, callback) {
                callback()
              },
            })
          : undefined,
        stdout: Readable.from(
          appServer
            ? [
                JSON.stringify({ id: 1, result: {} }) + '\n',
                JSON.stringify({ id: 2, result: codexAccount }) + '\n',
              ]
            : [raw],
        ),
        stderr: Readable.from([]),
        control: undefined,
        collected: {},
        done: Promise.resolve({ exitCode, signal: null }),
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      }
      statusProcesses.push(child)
      return child
    }),
  }
  const identity = vi.fn<AccountIdentitySource>(async () => undefined)
  const config: RuntimeConfig = {
    ...DEFAULT_CONFIG,
    stateDirectory: join(cwd, 'state'),
    zcodeAuthDirectory: join(cwd, 'zcode-auth'),
    zcodeExecutable: '/synthetic/zcode.cjs',
    grokExecutable: '/synthetic/grok',
    ompExecutable: '/synthetic/omp',
    piExecutable: '/synthetic/pi.js',
    hermesExecutable: '/synthetic/hermes',
    hermesHome: join(cwd, 'hermes-home'),
    opencodeExecutable: '/synthetic/opencode',
    ...overrides,
  }
  const manager = new AccountManager(backend, config, identity)
  managers.push(manager)
  return {
    cwd,
    config,
    manager,
    identity,
    backend,
    terminal,
    output,
    result,
    statusProcesses,
    signal: new AbortController().signal,
    status: (text: string, code = 0) => {
      raw = text
      exitCode = code
    },
    codexAccount: (account: unknown) => {
      codexAccount = { account }
    },
    delayCleanup: () => {
      waitCleanup = true
    },
    finishCleanup: () => cleanup.resolve(),
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('account status safety (synthetic CLI output)', () => {
  it('rejects MiMo file interpolation before status or account terminal starts', async () => {
    const f = fixture()
    mkdirSync(join(f.cwd, 'mimo/config'), { recursive: true })
    writeFileSync(
      join(f.cwd, 'mimo/config/mimocode.json'),
      JSON.stringify({
        provider: { openai: { options: { apiKey: '{file:~/.codex/auth.json}' } } },
      }),
    )
    expect(await f.manager.status('mimo', f.cwd, f.signal)).toMatchObject({ state: 'unavailable' })
    expect(f.backend.spawn).not.toHaveBeenCalled()
    await expect(f.manager.start('synthetic-parent', 'mimo', 'login', f.cwd, f.signal)).rejects.toThrow(
      'MiMo 配置含外部引用',
    )
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
    expect(f.manager.isBusy('mimo')).toBe(false)
  })

  it('blocks task/account admission when native status cleanup cannot be confirmed', async () => {
    const f = fixture()
    f.status('Logged in using an API key - SYNTHETIC_KEY')
    const original = f.backend.spawn
    f.backend.spawn = vi.fn((spec) => {
      const child = original(spec)
      vi.mocked(child.waitForExit).mockResolvedValue(false)
      return child
    })
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({
      state: 'unavailable',
      actions: [],
    })
    expect(f.manager.isBusy('codex')).toBe(true)
    expect(() => f.manager.start('p', 'codex', 'login', f.cwd, f.signal)).toThrow('cleanup')
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({ state: 'unavailable' })
    expect(f.backend.spawn).toHaveBeenCalledTimes(1)
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
  })

  it('returns allowlisted summaries without API keys, account fields, or raw exceptions', async () => {
    const f = fixture()
    f.status('Logged in using an API key - sk-SECRET-DO-NOT-EXPOSE')
    const codex = await f.manager.status('codex', f.cwd, f.signal)
    expect(codex).toMatchObject({ state: 'authenticated', summary: 'API 登录', authMethod: 'api' })
    expect(JSON.stringify(codex)).not.toContain('SECRET')
    f.status(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'oauth_token',
        email: 'private@example.com',
        accessToken: 'SECRET',
      }),
    )
    const claude = await f.manager.status('claude', f.cwd, f.signal)
    expect(claude).toMatchObject({ state: 'authenticated', summary: '已通过 OAuth 登录' })
    expect(JSON.stringify(claude)).not.toMatch(/SECRET|private@example/)
    expect(f.statusProcesses.every((child) => vi.mocked(child.terminate).mock.calls.length === 1)).toBe(true)
    expect(f.statusProcesses.every((child) => vi.mocked(child.waitForExit).mock.calls.length === 1)).toBe(
      true,
    )
  })

  it('distinguishes configured, unknown, unconfigured, and query failures without guessing credentials', async () => {
    const f = fixture()
    f.status('managed:kimi-code  type=kimi  models=4  source=oauth\n')
    expect(await f.manager.status('kimi', f.cwd, f.signal)).toMatchObject({ state: 'configured' })
    const kimiCall = vi.mocked(f.backend.spawn).mock.calls.at(-1)![0]
    expect(kimiCall.argv.slice(1)).toEqual(['provider', 'list'])
    expect(kimiCall.argv).not.toContain('--json')
    f.status('Provider: MiMo\nUser ID: private-uid\n')
    const mimo = await f.manager.status('mimo', f.cwd, f.signal)
    expect(mimo).toMatchObject({ state: 'authenticated', authMethod: 'api', verification: 'local' })
    expect(JSON.stringify(mimo)).not.toContain('private-uid')
    f.status('Transport error with SECRET', 1)
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({ state: 'unavailable' })
    f.status('Not logged in', 1)
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({ state: 'unconfigured' })
    const count = vi.mocked(f.backend.spawn).mock.calls.length
    expect(await f.manager.status('antigravity', f.cwd, f.signal)).toMatchObject({
      state: 'unknown',
      installed: true,
    })
    expect(f.backend.spawn).toHaveBeenCalledTimes(count)
  })

  it('only projects the account returned for the current authenticated session', async () => {
    const f = fixture()
    f.identity.mockResolvedValue({
      state: 'authenticated',
      summary: 'Local',
      authMethod: 'oauth',
      accountLabel: 'person@example.com',
      verification: 'local',
    })
    f.codexAccount({ type: 'chatgpt', email: 'person@example.com' })
    f.status('Logged in using ChatGPT')
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({
      accountLabel: 'person@example.com',
      authMethod: 'oauth',
      verification: 'cli',
    })
    f.status('Not logged in', 1)
    const loggedOut = await f.manager.status('codex', f.cwd, f.signal)
    expect(loggedOut.state).toBe('unconfigured')
    expect(loggedOut.accountLabel).toBeUndefined()
    f.status('Logged in using an API key - sk-SECRET')
    const api = await f.manager.status('codex', f.cwd, f.signal)
    expect(api.authMethod).toBe('api')
    expect(api.accountLabel).toBeUndefined()
    expect(f.identity).not.toHaveBeenCalled()
  })

  it('shows Claude email only for a confirmed claude.ai status and clears it after logout', async () => {
    const f = fixture()
    f.status(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'person@example.com',
        accessToken: 'SECRET',
        orgId: 'PRIVATE',
      }),
    )
    const loggedIn = await f.manager.status('claude', f.cwd, f.signal)
    expect(loggedIn).toMatchObject({
      state: 'authenticated',
      accountLabel: 'person@example.com',
      authMethod: 'oauth',
    })
    expect(JSON.stringify(loggedIn)).not.toMatch(/SECRET|PRIVATE/)
    f.status(JSON.stringify({ loggedIn: false, authMethod: 'claude.ai', email: 'person@example.com' }), 1)
    expect((await f.manager.status('claude', f.cwd, f.signal)).accountLabel).toBeUndefined()
    f.status(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'api_key',
        email: 'person@example.com',
        apiKeySource: 'sk-SECRET',
      }),
    )
    const api = await f.manager.status('claude', f.cwd, f.signal)
    expect(api).toMatchObject({ state: 'authenticated', authMethod: 'api' })
    expect(api.accountLabel).toBeUndefined()
    expect(JSON.stringify(api)).not.toContain('SECRET')
  })

  it('uses safe local Antigravity identity without launching any login or task process', async () => {
    const f = fixture()
    f.identity.mockResolvedValue({
      state: 'authenticated',
      summary: '已登录 Antigravity',
      authMethod: 'oauth',
      accountLabel: 'person@example.com',
      verification: 'local',
    })
    expect(await f.manager.status('antigravity', f.cwd, f.signal)).toMatchObject({
      state: 'authenticated',
      accountLabel: 'person@example.com',
      verification: 'local',
    })
    expect(f.backend.spawn).not.toHaveBeenCalled()
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
    f.identity.mockResolvedValue({ state: 'unauthenticated', summary: '尚未登录', verification: 'local' })
    expect((await f.manager.status('antigravity', f.cwd, f.signal)).accountLabel).toBeUndefined()
  })

  it('bounds oversized discovery and turns executable failures into safe unavailable summaries', async () => {
    const f = fixture()
    f.status('SECRET'.repeat(15_000))
    const result = await f.manager.status('claude', f.cwd, f.signal)
    expect(result.state).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    vi.mocked(f.backend.resolveExecutable).mockRejectedValue(new Error('file contains SECRET'))
    const missing = await f.manager.status('codex', f.cwd, f.signal)
    expect(missing).toMatchObject({ state: 'unconfigured', installed: false, actions: [] })
    expect(JSON.stringify(missing)).not.toContain('SECRET')
  })

  it('reports a mismatched CLI identity distinctly and never opens its account terminal', async () => {
    const f = fixture()
    vi.mocked(f.backend.resolveExecutable).mockRejectedValue(
      Object.assign(new Error('SECRET native mismatch'), { code: 'CLI_IDENTITY_MISMATCH' }),
    )
    const status = await f.manager.status('omp', f.cwd, f.signal)
    expect(status).toMatchObject({
      installed: true,
      state: 'unavailable',
      actions: [],
      summary: expect.stringContaining('OMP 执行入口身份不匹配'),
    })
    expect(JSON.stringify(status)).not.toContain('SECRET')
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
  })

  it('status lookup can be cancelled before spawn and does not launch an account process', async () => {
    const f = fixture()
    const resolution = deferred<string>()
    vi.mocked(f.backend.resolveExecutable).mockReturnValueOnce(resolution.promise)
    const controller = new AbortController()
    const operation = f.manager.status('codex', f.cwd, controller.signal)
    controller.abort()
    await expect(operation).rejects.toThrow('已取消')
    resolution.resolve('/synthetic/codex')
    await tick()
    expect(f.backend.spawn).not.toHaveBeenCalled()
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
  })

  it('keeps absent default installations grey but reports explicit executable and read errors', async () => {
    const missing = Object.assign(new Error('synthetic SECRET'), { code: 'ENOENT' })
    const absent = fixture()
    vi.mocked(absent.backend.resolveExecutable).mockRejectedValue(missing)
    expect(await absent.manager.status('codex', absent.cwd, absent.signal)).toMatchObject({
      state: 'unconfigured',
      installed: false,
      actions: [],
    })
    const custom = fixture({ codexExecutable: '/synthetic/missing-codex' })
    vi.mocked(custom.backend.resolveExecutable).mockRejectedValue(missing)
    const failed = await custom.manager.status('codex', custom.cwd, custom.signal)
    expect(failed).toMatchObject({
      state: 'unavailable',
      installed: false,
      summary: expect.stringContaining('执行路径配置失败'),
    })
    expect(JSON.stringify(failed)).not.toContain('SECRET')
    vi.mocked(absent.backend.resolveExecutable).mockRejectedValue(
      Object.assign(new Error('SECRET'), { code: 'EACCES' }),
    )
    expect(await absent.manager.status('codex', absent.cwd, absent.signal)).toMatchObject({
      state: 'unavailable',
      installed: false,
    })
    expect(absent.backend.spawn).not.toHaveBeenCalled()
    expect(custom.backend.spawn).not.toHaveBeenCalled()
  })

  it('distinguishes fresh absence, malformed responses and explicit authentication rejection', async () => {
    const f = fixture()
    f.status('No providers configured.\n')
    expect(await f.manager.status('kimi', f.cwd, f.signal)).toMatchObject({ state: 'unconfigured' })
    f.status('Not logged in. Run `mimo auth login` to log in.')
    expect(await f.manager.status('mimo', f.cwd, f.signal)).toMatchObject({ state: 'unconfigured' })
    f.status('{SECRET malformed')
    expect(await f.manager.status('claude', f.cwd, f.signal)).toMatchObject({ state: 'unavailable' })
    f.status('Authentication failed: invalid token SECRET', 1)
    const invalid = await f.manager.status('codex', f.cwd, f.signal)
    expect(invalid).toMatchObject({ state: 'unauthenticated', summary: expect.stringContaining('认证失效') })
    expect(JSON.stringify(invalid)).not.toContain('SECRET')
    f.status('Logged in using an API key - SECRET')
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({ state: 'authenticated' })
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
  })

  it('times out a stalled status query and awaits its process cleanup', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const stream = new PassThrough()
    const outcome = deferred<SubprocessOutcome>()
    const child = {
      stdin: undefined,
      stdout: stream,
      stderr: undefined,
      control: undefined,
      collected: {},
      done: outcome.promise,
      terminate: vi.fn(() => {
        stream.end()
        outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
      }),
      waitForExit: vi.fn(async () => true),
    }
    vi.mocked(f.backend.spawn).mockReturnValueOnce(child)
    const reading = f.manager.status('claude', f.cwd, f.signal)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await reading).toMatchObject({ state: 'unavailable', installed: true })
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
  })
})

describe('user-operated account terminals (synthetic PTY)', () => {
  it.each([
    ['codex', 'login', ['login']],
    ['claude', 'logout', ['auth', 'logout']],
    ['mimo', 'login', ['auth', 'login']],
    ['kimi', 'login', ['login']],
    ['kimi', 'logout', []],
    ['antigravity', 'login', []],
    ['antigravity', 'logout', []],
  ] as const)('%s %s uses only its verified argv and never injects input', async (cli, action, expected) => {
    const f = fixture()
    const opened = await f.manager.start('parent', cli, action, f.cwd, f.signal)
    const spec = vi.mocked(f.backend.spawnTerminal!).mock.calls[0][0]
    expect(spec.argv.slice(1)).toEqual(expected)
    expect(spec.cwd).toBe(f.cwd)
    expect(spec.terminalType).toBe('xterm-256color')
    expect(f.terminal.write).not.toHaveBeenCalled()
    if (cli === 'antigravity' || (cli === 'kimi' && action === 'logout'))
      expect(opened.instruction).toContain(`/${action}`)
    await f.manager.stop('parent', opened.id)
  })

  it('reserves a CLI before asynchronous startup and isolates every terminal operation by parent', async () => {
    const f = fixture()
    const resolution = deferred<string>()
    vi.mocked(f.backend.resolveExecutable).mockReturnValueOnce(resolution.promise)
    const first = f.manager.start('parent-a', 'codex', 'login', f.cwd, f.signal)
    expect(f.manager.isBusy('codex')).toBe(true)
    expect(f.manager.isBusy('claude')).toBe(false)
    expect(() => f.manager.start('parent-b', 'codex', 'login', f.cwd, f.signal)).toThrow('已有账号终端')
    resolution.resolve('/synthetic/codex')
    const { id } = await first
    await expect(f.manager.write('parent-b', id, 'text')).rejects.toThrow('不属于')
    await expect(f.manager.resize('parent-b', id, 90, 24)).rejects.toThrow('不属于')
    await expect(f.manager.stop('parent-b', id)).rejects.toThrow('不属于')
    await expect(f.manager.watch('parent-b', id, f.signal)[Symbol.asyncIterator]().next()).rejects.toThrow(
      '不属于',
    )
    expect(f.terminal.write).not.toHaveBeenCalled()
    await f.manager.write('parent-a', id, 'input\r')
    expect(f.terminal.write).toHaveBeenCalledWith('input\r')
  })

  it('rejects invalid actions, huge input and invalid terminal sizes', async () => {
    const f = fixture()
    expect(() => f.manager.start('p', 'codex', 'delete' as any, f.cwd, f.signal)).toThrow('不支持')
    expect(() => f.manager.start('p', 'shell' as CliId, 'manage', f.cwd, f.signal)).toThrow('不支持')
    const { id } = await f.manager.start('p', 'codex', 'manage', f.cwd, f.signal)
    await expect(f.manager.write('p', id, 'x'.repeat(16_385))).rejects.toThrow('超过限制')
    await expect(f.manager.resize('p', id, Infinity, 0)).rejects.toThrow('无效')
    expect(f.terminal.write).not.toHaveBeenCalled()
    expect(f.terminal.resize).not.toHaveBeenCalled()
  })

  it('does not report closed or release the CLI until the whole PTY session is gone', async () => {
    const f = fixture()
    const { id } = await f.manager.start('p', 'claude', 'login', f.cwd, f.signal)
    f.delayCleanup()
    let stopped = false
    const stop = f.manager.stop('p', id).then(() => {
      stopped = true
    })
    await tick()
    expect(stopped).toBe(false)
    expect(() => f.manager.start('p', 'claude', 'login', f.cwd, f.signal)).toThrow('已有账号终端')
    await expect(f.manager.write('p', id, 'late')).rejects.toThrow('已关闭')
    f.finishCleanup()
    await stop
    const frames = []
    for await (const frame of f.manager.watch('p', id, f.signal)) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ status: 'closed' })
    expect(f.terminal.terminate).toHaveBeenCalledTimes(1)
  })

  it('bounds retained output and preserves UTF8 chunks without persisting to worker records', async () => {
    const f = fixture()
    const { id } = await f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    f.output.write('X'.repeat(300_000))
    const bytes = Buffer.from('你好')
    for (const byte of bytes) f.output.write(Buffer.from([byte]))
    await tick()
    await f.manager.stop('p', id)
    const frames = []
    for await (const frame of f.manager.watch('p', id, f.signal)) frames.push(frame)
    const text = frames.map((frame) => frame.data ?? '').join('')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024)
    expect(text.endsWith('你好')).toBe(true)
    expect(frames[0].message).toContain('已从内存释放')
    expect(frames.every((frame, index) => index === 0 || frame.seq > frames[index - 1].seq)).toBe(true)
  })

  it('watch cancellation stops the owned terminal and waits for cleanup', async () => {
    const f = fixture()
    const { id } = await f.manager.start('p', 'kimi', 'manage', f.cwd, f.signal)
    const controller = new AbortController()
    const watch = f.manager.watch('p', id, controller.signal)[Symbol.asyncIterator]()
    expect((await watch.next()).value).toMatchObject({ status: 'running' })
    const next = watch.next()
    controller.abort()
    expect(await next).toMatchObject({ done: true })
    expect(f.terminal.terminate).toHaveBeenCalledTimes(1)
  })

  it('manager shutdown cancels a pending startup before it can publish a terminal', async () => {
    const f = fixture()
    const allocated = deferred<SubprocessTerminalHandle>()
    vi.mocked(f.backend.spawnTerminal!).mockReturnValueOnce(allocated.promise)
    const opened = f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    await tick()
    const rejected = expect(opened).rejects.toThrow('已取消')
    const closed = f.manager.close()
    allocated.resolve(f.terminal)
    await rejected
    await closed
    expect(f.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(() => f.manager.start('p', 'codex', 'login', f.cwd, f.signal)).toThrow()
  })

  it('times out a stalled PTY allocation promptly and cleans its late process before allowing retry', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const allocated = deferred<SubprocessTerminalHandle>()
    vi.mocked(f.backend.spawnTerminal!).mockReturnValueOnce(allocated.promise)
    const opening = f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    const failed = expect(opening).rejects.toThrow('启动超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
    expect(f.manager.isBusy('codex')).toBe(true)
    expect(vi.mocked(f.backend.spawnTerminal!).mock.calls[0]![0].signal?.aborted).toBe(true)
    expect(() => f.manager.start('p', 'codex', 'login', f.cwd, f.signal)).toThrow('已有账号终端')
    allocated.resolve(f.terminal)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.terminal.terminate).toHaveBeenCalledOnce()
    expect(f.manager.isBusy('codex')).toBe(false)
  })

  it('keeps a connected login terminal alive beyond startup timeout and request cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const request = new AbortController()
    const { id } = await f.manager.start('p', 'antigravity', 'login', f.cwd, request.signal)
    const watching = f.manager.watch('p', id, f.signal)[Symbol.asyncIterator]()
    await watching.next()
    const spec = vi.mocked(f.backend.spawnTerminal!).mock.calls[0]![0]
    await vi.advanceTimersByTimeAsync(31_000)
    request.abort()
    expect(spec.signal?.aborted).toBe(false)
    expect(f.terminal.terminate).not.toHaveBeenCalled()
    await f.manager.write('p', id, '/login\r')
    expect(f.terminal.write).toHaveBeenCalledWith('/login\r')
    await f.manager.stop('p', id)
    await watching.return?.()
  })

  it('returns cancellation before a slow provider settles but retains ownership until cleanup', async () => {
    const f = fixture()
    const allocated = deferred<SubprocessTerminalHandle>()
    vi.mocked(f.backend.spawnTerminal!).mockReturnValueOnce(allocated.promise)
    const request = new AbortController()
    const opening = f.manager.start('p', 'codex', 'login', f.cwd, request.signal)
    await tick()
    const failed = expect(opening).rejects.toThrow('已取消')
    request.abort()
    await failed
    expect(f.manager.isBusy('codex')).toBe(true)
    allocated.resolve(f.terminal)
    await tick()
    expect(f.terminal.terminate).toHaveBeenCalledOnce()
    expect(f.manager.isBusy('codex')).toBe(false)
  })

  it('releases a rejected allocation for retry without exposing provider errors', async () => {
    const f = fixture()
    vi.mocked(f.backend.spawnTerminal!).mockRejectedValueOnce(new Error('SECRET provider details'))
    await expect(f.manager.start('p', 'claude', 'login', f.cwd, f.signal)).rejects.toThrow('无法启动账号终端')
    expect(f.manager.isBusy('claude')).toBe(false)
    expect((await f.manager.start('p', 'claude', 'login', f.cwd, f.signal)).id).toBeTruthy()
  })

  it('closing a parent cancels its pending allocation without affecting a different parent', async () => {
    const f = fixture()
    const other = fixture()
    const allocated = deferred<SubprocessTerminalHandle>()
    vi.mocked(f.backend.spawnTerminal!)
      .mockReturnValueOnce(allocated.promise)
      .mockResolvedValueOnce(other.terminal)
    const opening = f.manager.start('p1', 'codex', 'login', f.cwd, f.signal)
    await tick()
    const running = await f.manager.start('p2', 'claude', 'login', f.cwd, f.signal)
    const failed = expect(opening).rejects.toThrow('已取消')
    const closing = f.manager.closeParent('p1')
    expect(f.manager.isBusy('codex')).toBe(true)
    allocated.resolve(f.terminal)
    await failed
    await closing
    expect(f.manager.isBusy('codex')).toBe(false)
    expect(f.manager.isBusy('claude')).toBe(true)
    expect(f.terminal.terminate).toHaveBeenCalledTimes(1)
    expect(other.terminal.terminate).not.toHaveBeenCalled()
    await f.manager.write('p2', running.id, 'still here')
    expect(other.terminal.write).toHaveBeenCalledWith('still here')
  })

  it('allows a fresh parent lifetime while the old one is waiting for cleanup', async () => {
    const f = fixture()
    const fresh = fixture()
    vi.mocked(f.backend.spawnTerminal!)
      .mockResolvedValueOnce(f.terminal)
      .mockResolvedValueOnce(fresh.terminal)
    await f.manager.start('same-parent', 'codex', 'login', f.cwd, f.signal)
    f.delayCleanup()
    const closing = f.manager.closeParent('same-parent')
    const newTerminal = await f.manager.start('same-parent', 'claude', 'login', f.cwd, f.signal)
    f.finishCleanup()
    await closing
    expect(fresh.terminal.terminate).not.toHaveBeenCalled()
    await f.manager.write('same-parent', newTerminal.id, 'new lifetime')
    expect(fresh.terminal.write).toHaveBeenCalledWith('new lifetime')
    await f.manager.closeParent('same-parent')
    expect(fresh.terminal.terminate).toHaveBeenCalledTimes(1)
  })

  it('closing a parent interrupts executable lookup and a late result cannot spawn', async () => {
    const f = fixture()
    const executable = deferred<string>()
    vi.mocked(f.backend.resolveExecutable).mockReturnValueOnce(executable.promise)
    const opening = f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    const failed = expect(opening).rejects.toThrow()
    await f.manager.closeParent('p')
    await failed
    executable.resolve('/synthetic/codex')
    await tick()
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
    expect(f.manager.isBusy('codex')).toBe(false)
    const opened = await f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    expect(opened.id).toBeTruthy()
  })

  it('a failed cleanup keeps the CLI reserved and stop retries instead of claiming success', async () => {
    const f = fixture()
    const { id } = await f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    vi.mocked(f.terminal.terminate).mockRejectedValueOnce(new Error('provider SECRET failure'))
    await expect(f.manager.stop('p', id)).rejects.toThrow('尚未确认完全退出')
    expect(() => f.manager.start('p', 'codex', 'login', f.cwd, f.signal)).toThrow('已有账号终端')
    await f.manager.stop('p', id)
    expect(f.terminal.terminate).toHaveBeenCalledTimes(2)
  })

  it('a startup cancellation that cannot clean up retains the CLI lock', async () => {
    const f = fixture()
    const allocated = deferred<SubprocessTerminalHandle>()
    vi.mocked(f.backend.spawnTerminal!).mockReturnValueOnce(allocated.promise)
    const controller = new AbortController()
    const opening = f.manager.start('p', 'codex', 'login', f.cwd, controller.signal)
    await tick()
    controller.abort()
    vi.mocked(f.terminal.terminate).mockRejectedValueOnce(new Error('cleanup failed'))
    allocated.resolve(f.terminal)
    await expect(opening).rejects.toThrow('清理失败')
    expect(f.manager.isBusy('codex')).toBe(true)
    expect(() => f.manager.start('p', 'codex', 'login', f.cwd, f.signal)).toThrow('已有账号终端')
    await f.manager.close()
    expect(f.terminal.terminate).toHaveBeenCalledTimes(2)
  })

  it('expires an account terminal after 30 minutes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { id } = await f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    const watching = f.manager.watch('p', id, f.signal)[Symbol.asyncIterator]()
    await watching.next()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    const frames = []
    for await (const frame of f.manager.watch('p', id, f.signal)) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ status: 'closed', message: expect.stringContaining('30 分钟') })
    await watching.return?.()
  })

  it('closes an orphan terminal after 30 seconds if the client never attaches', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { id } = await f.manager.start('p', 'codex', 'login', f.cwd, f.signal)
    await vi.advanceTimersByTimeAsync(30_000)
    const frames = []
    for await (const frame of f.manager.watch('p', id, f.signal)) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ status: 'closed', message: expect.stringContaining('未连接') })
    expect(f.manager.isBusy('codex')).toBe(false)
  })
})

describe('extended CLI account capabilities (synthetic credentials and PTYs)', () => {
  it('offers account actions for all six extended CLIs without starting any login process', async () => {
    const f = fixture()
    for (const cli of ['zcode', 'grok', 'omp', 'pi', 'hermes', 'opencode'] as const) {
      const account = await f.manager.status(cli, f.cwd, f.signal)
      expect(account.installed).toBe(true)
      {
        expect(account.actions.map((item) => item.id)).toContain('login')
        expect(account.actions.map((item) => item.id)).toContain('manage')
      }
      expect(account.state).not.toBe('authenticated')
    }
    expect(f.backend.spawn).not.toHaveBeenCalled()
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
  })

  it.each(['pi', 'omp', 'opencode'] as const)(
    '%s routes login to a terminal even with a managed API reference',
    async (cli) => {
      const f = fixture({
        zaiCredentialRef: 'synthetic-ref',
        resolveCredential: async () => 'SYNTHETIC_SECRET',
      })
      const account = await f.manager.status(cli, f.cwd, f.signal)
      expect(account.actions.find((x) => x.id === 'login')).toMatchObject({ label: '登录设置' })
      expect(account.actions.every((x) => x.target !== 'models')).toBe(true)
      expect(JSON.stringify(account)).not.toContain('SYNTHETIC_SECRET')
      const opened = await f.manager.start('p', cli, 'login', f.cwd, f.signal)
      expect(opened.id).toBeTruthy()
      expect(f.backend.spawnTerminal).toHaveBeenCalledOnce()
    },
  )
  it('rejects removed Harness account operations before any process starts', async () => {
    const f = fixture()
    await expect(f.manager.status('harness', f.cwd, f.signal)).rejects.toThrow('不支持')
    expect(() => f.manager.start('p', 'harness', 'login', f.cwd, f.signal)).toThrow('不支持')
    expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
  })
  it.each(['pi', 'omp'] as const)('%s login works without Host API credentials', async (cli) => {
    const f = fixture()
    const opened = await f.manager.start('p', cli, 'login', f.cwd, f.signal)
    expect(opened.id).toBeTruthy()
    expect(f.backend.spawnTerminal).toHaveBeenCalledOnce()
  })

  it.each(['login', 'manage'] as const)(
    'Grok %s uses its native argv and shared account path',
    async (action) => {
      const f = fixture()
      const opened = await f.manager.start('p', 'grok', action, f.cwd, f.signal)
      const spec = vi.mocked(f.backend.spawnTerminal!).mock.calls[0]![0]
      expect(spec.argv).toEqual([
        process.execPath,
        fileURLToPath(new URL('../src/host/private-launch.mjs', import.meta.url)),
        '/synthetic/grok',
        ...(action === 'login' ? ['login'] : []),
      ])
      expect(spec.env?.GROK_HOME).toMatch(/\/\.grok$/)
      expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(spec.cwd).toBe(join(f.config.stateDirectory!, 'accounts/grok-terminal/workspace'))
      expect(f.backend.spawn).not.toHaveBeenCalled()
      expect(f.terminal.write).not.toHaveBeenCalled()
      await f.manager.stop('p', opened.id)
    },
  )

  it.each(['pi', 'omp'] as const)(
    '%s releases its private runtime only after successful terminal cleanup',
    async (cli) => {
      const f = fixture({
        zaiCredentialRef: 'synthetic-host-ref',
        resolveCredential: async () => 'SYNTHETIC_KEY',
      })
      const opened = await f.manager.start('p', cli, 'manage', f.cwd, f.signal)
      const spec = vi.mocked(f.backend.spawnTerminal!).mock.calls[0]![0]
      expect(spec.cwd).not.toBe(f.cwd)
      expect(spec.env?.ZAI_CODING_CN_API_KEY).toBeUndefined()
      expect(spec.argv).not.toContain('SYNTHETIC_KEY')
      expect(existsSync(spec.cwd)).toBe(true)
      f.delayCleanup()
      // Simulate the native TUI exiting by itself; finish still owns process cleanup.
      f.output.end()
      f.result.resolve({ exitCode: 0, signal: null })
      await tick()
      expect(f.terminal.terminate).toHaveBeenCalledOnce()
      expect(f.manager.isBusy(cli)).toBe(true)
      expect(existsSync(spec.cwd)).toBe(true)
      f.finishCleanup()
      await f.manager.stop('p', opened.id)
      expect(existsSync(spec.cwd)).toBe(false)
      expect(f.manager.isBusy(cli)).toBe(false)
      expect(readdirSync(join(f.config.stateDirectory!, 'account-runtime'))).toEqual([])
    },
  )

  it.each(['pi', 'omp'] as const)(
    '%s retains a cancelled runtime for a late PTY until that PTY has actually exited',
    async (cli) => {
      const f = fixture({
        zaiCredentialRef: 'synthetic-host-ref',
        resolveCredential: async () => 'SYNTHETIC_KEY',
      })
      const allocated = deferred<SubprocessTerminalHandle>()
      vi.mocked(f.backend.spawnTerminal!).mockReturnValueOnce(allocated.promise)
      const request = new AbortController()
      const opening = f.manager.start('p', cli, 'manage', f.cwd, request.signal)
      const failed = expect(opening).rejects.toThrow('已取消')
      await vi.waitFor(() => expect(f.backend.spawnTerminal).toHaveBeenCalledOnce())
      const runtime = vi.mocked(f.backend.spawnTerminal!).mock.calls[0]![0].cwd
      request.abort()
      await failed
      expect(existsSync(runtime)).toBe(true)
      expect(f.manager.isBusy(cli)).toBe(true)
      f.delayCleanup()
      allocated.resolve(f.terminal)
      await tick()
      expect(f.terminal.terminate).toHaveBeenCalledOnce()
      expect(existsSync(runtime)).toBe(true)
      f.finishCleanup()
      await f.manager.closeParent('p')
      expect(existsSync(runtime)).toBe(false)
      expect(f.manager.isBusy(cli)).toBe(false)
    },
  )

  it.each(['pi', 'omp'] as const)(
    '%s releases a prepared runtime when terminal allocation fails and permits retry',
    async (cli) => {
      const f = fixture({
        zaiCredentialRef: 'synthetic-host-ref',
        resolveCredential: async () => 'SYNTHETIC_KEY',
      })
      vi.mocked(f.backend.spawnTerminal!).mockRejectedValueOnce(new Error('SYNTHETIC_PROVIDER_SECRET'))
      await expect(f.manager.start('p', cli, 'manage', f.cwd, f.signal)).rejects.toThrow('无法启动账号终端')
      const runtime = vi.mocked(f.backend.spawnTerminal!).mock.calls[0]![0].cwd
      expect(existsSync(runtime)).toBe(false)
      expect(f.manager.isBusy(cli)).toBe(false)
      const opened = await f.manager.start('p', cli, 'manage', f.cwd, f.signal)
      expect(vi.mocked(f.backend.spawnTerminal!).mock.calls[1]![0].cwd).not.toBe(runtime)
      await f.manager.stop('p', opened.id)
    },
  )
})
