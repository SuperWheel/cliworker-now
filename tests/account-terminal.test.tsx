import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AccountTerminal } from '../src/client/account-terminal.tsx'
import type { API } from '../src/client/workers.ts'
import type { AccountAction, AccountFrame } from '../src/shared/accounts.ts'
import type { CliId } from '../src/shared/types.ts'

// Simulated PTY/Gateway and renderer only; these tests never invoke an installed CLI.
const terminals = vi.hoisted(() => [] as any[])
const faults = vi.hoisted(() => ({ constructor: false, open: false }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, any>
    cols = 80
    rows = 24
    input?: (text: string) => void
    write = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    open = vi.fn(() => {
      if (faults.open) {
        faults.open = false
        throw new Error('simulated renderer initialization failure')
      }
    })
    loadAddon = vi.fn()
    constructor(options: Record<string, any>) {
      if (faults.constructor) {
        faults.constructor = false
        throw new Error('simulated terminal initialization failure')
      }
      this.options = options
      terminals.push(this)
    }
    onData(callback: (text: string) => void) {
      this.input = callback
      return {
        dispose: vi.fn(() => {
          this.input = undefined
        }),
      }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) =>
    createElement('button', props, children),
  StateDot: ({ state }: any) => createElement('span', { 'data-state': state }),
}))

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const ok = (value: unknown = true) => ({ ok: true, value })
const started = (id: string) => ok(JSON.stringify({ id, instruction: '模拟账号交互' }))

class AccountStream {
  private queue: AccountFrame[] = []
  private done = false
  private failure?: Error
  private wake?: () => void
  accept = vi.fn()
  dispose = vi.fn(async () => {
    this.done = true
    this.wake?.()
  })
  push(frame: AccountFrame) {
    this.queue.push(frame)
    this.wake?.()
  }
  end() {
    this.done = true
    this.wake?.()
  }
  fail() {
    this.failure = new Error('simulated stream failure')
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.failure) throw this.failure
      const frame = this.queue.shift()
      if (frame) yield { value: JSON.stringify(frame), accept: this.accept }
      else if (this.done) return
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}

const mounted: ReactTestRenderer[] = []
beforeEach(() => {
  terminals.length = 0
  faults.constructor = false
  faults.open = false
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function setup(initiallyOpen = true) {
  const starts: ReturnType<typeof deferred>[] = []
  const streams: AccountStream[] = []
  const accountStart = vi.fn(() => {
    const pending = deferred()
    starts.push(pending)
    return pending.promise
  })
  const accountWrite = vi.fn().mockResolvedValue(ok())
  const accountStop = vi.fn().mockResolvedValue(ok())
  const accountResize = vi.fn().mockResolvedValue(ok())
  const accountWatch = vi.fn(() => {
    const stream = new AccountStream()
    streams.push(stream)
    return stream
  })
  const api = {
    $stream: (options: any) => options.open(new AbortController().signal),
    cliworker: { accountStart, accountWatch, accountWrite, accountStop, accountResize },
  } as unknown as API
  const onClose = vi.fn(),
    onFinished = vi.fn()
  const render = (cli: CliId = 'codex', action: AccountAction = 'login') => (
    <AccountTerminal
      api={api}
      sessionId="parent"
      cli={cli}
      action={action}
      onClose={onClose}
      onFinished={onFinished}
    />
  )
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(initiallyOpen ? render() : null, {
      createNodeMock: (node) => (node.props.className === 'cwn-account-terminal-view' ? {} : null),
    })
    mounted.push(renderer)
  })
  const update = async (cli: CliId = 'codex', action: AccountAction = 'login') => {
    await act(async () => {
      renderer.update(render(cli, action))
    })
  }
  const start = async (id = 'terminal-a', index = 0) => {
    await act(async () => {
      starts[index].resolve(started(id))
    })
  }
  const click = async (label: string) => {
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes(label))!
        .props.onClick()
    })
  }
  const close = () => click('关闭终端')
  const unmount = async () => {
    await act(async () => {
      renderer.unmount()
    })
    mounted.splice(mounted.indexOf(renderer), 1)
  }
  return {
    renderer,
    starts,
    streams,
    accountStart,
    accountWatch,
    accountWrite,
    accountStop,
    onClose,
    onFinished,
    update,
    start,
    close,
    click,
    unmount,
  }
}

it('starts an account action only when explicitly mounted and never enters a prompt automatically', async () => {
  const fixture = await setup(false)
  expect(fixture.accountStart).not.toHaveBeenCalled()
  await fixture.update('kimi', 'manage')
  expect(fixture.accountStart).toHaveBeenCalledWith('parent', 'kimi', 'manage', expect.any(AbortSignal))
  expect(terminals[0].options.disableStdin).toBe(true)
  await fixture.start()
  expect(terminals[0].options.disableStdin).toBe(false)
  expect(fixture.accountWatch).toHaveBeenCalledWith('parent', 'terminal-a', expect.any(AbortSignal))
  expect(fixture.accountWrite).not.toHaveBeenCalled()
  const text = JSON.stringify(fixture.renderer.toJSON())
  expect(text).toContain('模拟账号交互')
  expect(text).not.toMatch(/插件不保存|关闭此窗口会结束|cwn-account-privacy/)
})

it('aborts an unmounted start and cleans up its late terminal id without opening a stream', async () => {
  const fixture = await setup()
  const signal = fixture.accountStart.mock.calls[0][3] as AbortSignal
  await fixture.unmount()
  expect(signal.aborted).toBe(true)
  expect(terminals[0].dispose).toHaveBeenCalledOnce()
  await fixture.start('late-terminal')
  expect(fixture.accountStop).toHaveBeenCalledWith('parent', 'late-terminal')
  expect(fixture.accountWatch).not.toHaveBeenCalled()
  expect(fixture.onFinished).not.toHaveBeenCalled()
})

it('keeps a cancelled pending start closed even if its parent has not unmounted yet', async () => {
  const fixture = await setup()
  const signal = fixture.accountStart.mock.calls[0][3] as AbortSignal
  await fixture.close()
  expect(signal.aborted).toBe(true)
  expect(fixture.onClose).toHaveBeenCalledOnce()
  await fixture.start('cancelled-terminal')
  expect(fixture.accountStop).toHaveBeenCalledWith('parent', 'cancelled-terminal')
  expect(fixture.accountWatch).not.toHaveBeenCalled()
  expect(terminals[0].options.disableStdin).toBe(true)
})

it('disables input on a terminal completion and notifies completion only once', async () => {
  const fixture = await setup()
  await fixture.start()
  await act(async () => {
    fixture.streams[0].push({ seq: 1, data: 'ready\r\n' })
    fixture.streams[0].push({ seq: 1, data: 'duplicate' })
    fixture.streams[0].push({ seq: 2, status: 'closed' })
  })
  expect(terminals[0].write.mock.calls).toEqual([['ready\r\n']])
  expect(terminals[0].options.disableStdin).toBe(true)
  expect(fixture.onFinished).toHaveBeenCalledOnce()
  await act(async () => {
    terminals[0].input('ignored input')
  })
  expect(fixture.accountWrite).not.toHaveBeenCalled()
  await fixture.close()
  expect(fixture.onFinished).toHaveBeenCalledOnce()
  expect(fixture.onClose).toHaveBeenCalledOnce()
})

it('also disables input when the remote stream ends without a final status frame', async () => {
  const fixture = await setup()
  await fixture.start()
  await act(async () => {
    fixture.streams[0].end()
  })
  expect(terminals[0].options.disableStdin).toBe(true)
  expect(fixture.onFinished).toHaveBeenCalledOnce()
  await act(async () => {
    terminals[0].input('ignored input')
  })
  expect(fixture.accountWrite).not.toHaveBeenCalled()
})

it('serializes typed chunks so a slow write cannot reorder CLI input', async () => {
  const fixture = await setup()
  await fixture.start()
  const first = deferred()
  fixture.accountWrite.mockImplementationOnce(() => first.promise)
  await act(async () => {
    terminals[0].input('first')
    terminals[0].input('second')
    terminals[0].input('\r')
  })
  expect(fixture.accountWrite.mock.calls).toEqual([['parent', 'terminal-a', 'first']])
  await act(async () => {
    first.resolve(ok())
  })
  expect(fixture.accountWrite.mock.calls).toEqual([
    ['parent', 'terminal-a', 'first'],
    ['parent', 'terminal-a', 'second'],
    ['parent', 'terminal-a', '\r'],
  ])
})

it('cleans up an old delayed start without stopping the newly selected CLI terminal', async () => {
  const fixture = await setup()
  const oldSignal = fixture.accountStart.mock.calls[0][3] as AbortSignal
  await fixture.update('claude', 'login')
  expect(oldSignal.aborted).toBe(true)
  await fixture.start('new-terminal', 1)
  await fixture.start('old-terminal', 0)
  expect(fixture.accountStop.mock.calls).toEqual([['parent', 'old-terminal']])
  expect(fixture.accountWatch.mock.calls.map((args) => args[1])).toEqual(['new-terminal'])
  expect(terminals[1].options.disableStdin).toBe(false)
  expect(fixture.onFinished).not.toHaveBeenCalled()
})

it('shows a recoverable error instead of an endless spinner when terminal construction fails', async () => {
  faults.constructor = true
  const fixture = await setup()
  expect(fixture.accountStart).not.toHaveBeenCalled()
  expect(JSON.stringify(fixture.renderer.toJSON())).toContain('账号终端显示未能初始化')
  expect(fixture.renderer.root.findAllByProps({ 'data-state': 'ongoing' })).toHaveLength(0)
  await fixture.click('重试')
  expect(fixture.accountStart).toHaveBeenCalledOnce()
  await fixture.start()
  expect(terminals[0].options.disableStdin).toBe(false)
})

it('disposes a partially initialized terminal and can retry without crashing the parent page', async () => {
  faults.open = true
  const fixture = await setup()
  expect(fixture.accountStart).not.toHaveBeenCalled()
  expect(terminals[0].dispose).toHaveBeenCalledOnce()
  await fixture.click('重试')
  expect(terminals[0].dispose).toHaveBeenCalledOnce()
  await fixture.start()
  expect(terminals[1].options.disableStdin).toBe(false)
})

it('bounds an unresponsive startup, supports retry, and still cleans a late old terminal', async () => {
  vi.useFakeTimers()
  const fixture = await setup()
  const oldSignal = fixture.accountStart.mock.calls[0][3] as AbortSignal
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(oldSignal.aborted).toBe(true)
  expect(JSON.stringify(fixture.renderer.toJSON())).toContain('启动超过 20 秒')
  expect(fixture.renderer.root.findAllByProps({ 'data-state': 'ongoing' })).toHaveLength(0)
  await fixture.click('重试')
  expect(fixture.accountStart).toHaveBeenCalledTimes(2)
  await fixture.start('retry-terminal', 1)
  await fixture.start('timed-out-terminal', 0)
  expect(fixture.accountStop.mock.calls).toEqual([['parent', 'timed-out-terminal']])
  expect(fixture.accountWatch.mock.calls.map((args) => args[1])).toEqual(['retry-terminal'])
  expect(terminals[1].options.disableStdin).toBe(false)
})

it('lets a failed RPC be retried without automatically retrying the login action', async () => {
  const fixture = await setup()
  await act(async () => {
    fixture.starts[0].reject(new Error('simulated gateway failure'))
  })
  expect(fixture.accountStart).toHaveBeenCalledOnce()
  expect(fixture.renderer.root.findAllByProps({ 'data-state': 'ongoing' })).toHaveLength(0)
  await fixture.click('重试')
  expect(fixture.accountStart).toHaveBeenCalledTimes(2)
  await fixture.start('retry-terminal', 1)
  expect(terminals[1].options.disableStdin).toBe(false)
})

it('bounds the closing spinner and waits for cleanup before permitting a retry', async () => {
  vi.useFakeTimers()
  const fixture = await setup()
  await fixture.start()
  const cleanup = deferred()
  fixture.accountStop.mockImplementation(() => cleanup.promise)
  await fixture.close()
  expect(fixture.renderer.root.findAllByProps({ 'data-state': 'ongoing' })).toHaveLength(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000)
  })
  expect(fixture.renderer.root.findAllByProps({ 'data-state': 'ongoing' })).toHaveLength(0)
  expect(JSON.stringify(fixture.renderer.toJSON())).toContain('终端关闭失败，请重试')
  expect(fixture.onClose).not.toHaveBeenCalled()
  await fixture.click('重试')
  expect(fixture.accountStart).toHaveBeenCalledOnce()
  await act(async () => {
    cleanup.resolve(ok())
  })
  expect(fixture.accountStart).toHaveBeenCalledTimes(2)
  await fixture.start('retry-terminal', 1)
})

it('drops unsent input once the user starts closing the terminal', async () => {
  const fixture = await setup()
  await fixture.start()
  const first = deferred()
  const cleanup = deferred()
  fixture.accountWrite.mockImplementationOnce(() => first.promise)
  fixture.accountStop.mockImplementation(() => cleanup.promise)
  await act(async () => {
    terminals[0].input('first')
    terminals[0].input('queued')
  })
  await fixture.close()
  await act(async () => {
    first.resolve(ok())
  })
  expect(fixture.accountWrite.mock.calls).toEqual([['parent', 'terminal-a', 'first']])
  await act(async () => {
    cleanup.resolve(ok())
  })
})

it('immediately releases a failed stream even while process cleanup is still pending', async () => {
  const fixture = await setup()
  await fixture.start()
  const cleanup = deferred()
  fixture.accountStop.mockImplementation(() => cleanup.promise)
  await act(async () => {
    fixture.streams[0].fail()
  })
  expect(fixture.streams[0].dispose).toHaveBeenCalledOnce()
  expect(fixture.accountStop).toHaveBeenCalledWith('parent', 'terminal-a')
  expect(terminals[0].options.disableStdin).toBe(true)
  expect(fixture.onFinished).toHaveBeenCalledOnce()
  await fixture.unmount()
  expect(fixture.streams[0].dispose).toHaveBeenCalledOnce()
  expect(fixture.accountStop).toHaveBeenCalledOnce()
  await act(async () => {
    cleanup.resolve(ok())
  })
})
