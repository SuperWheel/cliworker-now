import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, Readable } from 'node:stream'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { AccountManager } from '../src/host/accounts.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import type { CliId } from '../src/shared/types.ts'

// All subprocesses in this suite are synthetic. No real login/logout is run.
const roots: string[] = []
const managers: AccountManager[] = []
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
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
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-account-test-')))
  roots.push(cwd)
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
  const statusProcesses: SubprocessHandle[] = []
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async (name) => (name.startsWith('/') ? name : `/synthetic/${name}`)),
    spawnTerminal: vi.fn(async () => terminal),
    spawn: vi.fn(() => {
      const child: SubprocessHandle = {
        stdin: undefined,
        stdout: Readable.from([raw]),
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
  const manager = new AccountManager(backend, DEFAULT_CONFIG)
  managers.push(manager)
  return {
    cwd,
    manager,
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
    delayCleanup: () => {
      waitCleanup = true
    },
    finishCleanup: () => cleanup.resolve(),
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('account status safety (synthetic CLI output)', () => {
  it('returns allowlisted summaries without API keys, account fields, or raw exceptions', async () => {
    const f = fixture()
    f.status('Logged in using an API key - sk-SECRET-DO-NOT-EXPOSE')
    const codex = await f.manager.status('codex', f.cwd, f.signal)
    expect(codex).toMatchObject({ state: 'authenticated', summary: '已使用 API Key 登录' })
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

  it('distinguishes configured, unknown, and unauthenticated without guessing credentials', async () => {
    const f = fixture()
    f.status('managed:kimi-code  type=kimi  models=4  source=oauth\n')
    expect(await f.manager.status('kimi', f.cwd, f.signal)).toMatchObject({ state: 'configured' })
    const kimiCall = vi.mocked(f.backend.spawn).mock.calls.at(-1)![0]
    expect(kimiCall.argv.slice(1)).toEqual(['provider', 'list'])
    expect(kimiCall.argv).not.toContain('--json')
    f.status('Provider: MiMo\nUser ID: private-uid\n')
    const mimo = await f.manager.status('mimo', f.cwd, f.signal)
    expect(mimo).toMatchObject({ state: 'configured' })
    expect(JSON.stringify(mimo)).not.toContain('private-uid')
    f.status('Transport error with SECRET', 1)
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({ state: 'unknown' })
    f.status('Not logged in', 1)
    expect(await f.manager.status('codex', f.cwd, f.signal)).toMatchObject({ state: 'unauthenticated' })
    const count = vi.mocked(f.backend.spawn).mock.calls.length
    expect(await f.manager.status('antigravity', f.cwd, f.signal)).toMatchObject({
      state: 'unknown',
      installed: true,
    })
    expect(f.backend.spawn).toHaveBeenCalledTimes(count)
  })

  it('bounds oversized discovery and turns executable failures into safe unavailable summaries', async () => {
    const f = fixture()
    f.status('SECRET'.repeat(15_000))
    const result = await f.manager.status('claude', f.cwd, f.signal)
    expect(result.state).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    vi.mocked(f.backend.resolveExecutable).mockRejectedValue(new Error('file contains SECRET'))
    const missing = await f.manager.status('codex', f.cwd, f.signal)
    expect(missing).toMatchObject({ state: 'unavailable', installed: false, actions: [] })
    expect(JSON.stringify(missing)).not.toContain('SECRET')
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
