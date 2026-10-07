import { describe, expect, it, vi } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { readCodexAccount } from '../src/host/codex-account.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import type { SubprocessOutcome, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

// A synthetic app-server; never reads local auth files or invokes a real CLI.
function fixture(account: unknown, options: { error?: boolean; oversized?: boolean; stall?: boolean } = {}) {
  const output = new PassThrough(),
    errors = new PassThrough()
  const messages: any[] = []
  let finish!: (outcome: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>((resolve) => {
    finish = resolve
  })
  const child: SubprocessHandle = {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk))
        messages.push(message)
        callback()
        if (message.method === 'initialize') output.write(JSON.stringify({ id: 1, result: {} }) + '\n')
        if (message.method === 'account/read' && !options.stall) {
          if (options.oversized) output.write('SECRET'.repeat(12_000))
          else
            output.write(
              JSON.stringify(
                options.error
                  ? { id: 2, error: { message: 'SECRET' } }
                  : { id: 2, result: { account, requiresOpenaiAuth: true } },
              ) + '\n',
            )
        }
      },
    }),
    stdout: output,
    stderr: errors,
    control: undefined,
    collected: {},
    done,
    terminate: vi.fn(() => {
      output.end()
      errors.end()
      finish({ exitCode: 0, signal: null })
    }),
    waitForExit: vi.fn(async () => true),
  }
  const backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn(() => child) }
  return {
    backend,
    messages,
    child,
    run: (signal = new AbortController().signal) =>
      readCodexAccount(backend, DEFAULT_CONFIG, '/synthetic/codex', '/synthetic/project', signal),
  }
}

describe('Codex effective-account read-only handshake', () => {
  it('gets current account through Codex and never asks for a task, login, or token refresh', async () => {
    const f = fixture({
      type: 'chatgpt',
      email: 'current@example.com',
      planType: 'plus',
      access_token: 'SECRET',
    })
    expect(await f.run()).toMatchObject({
      state: 'authenticated',
      authMethod: 'oauth',
      accountLabel: 'current@example.com',
      verification: 'cli',
    })
    expect(f.messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'account/read'])
    expect(f.messages[0].params.capabilities.explicitGatewayOauth).toBe(true)
    expect(f.messages[2].params).toEqual({ refreshToken: false })
    expect(vi.mocked(f.backend.spawn).mock.calls[0]![0].argv).toEqual([
      '/synthetic/codex',
      'app-server',
      '--stdio',
    ])
    expect(f.child.terminate).toHaveBeenCalledOnce()
    expect(f.child.waitForExit).toHaveBeenCalledOnce()
  })

  it('does not expose API account metadata or any raw credential-shaped fields', async () => {
    const f = fixture({ type: 'apiKey', email: 'old@example.com', key: 'sk-SECRET' })
    const result = await f.run()
    expect(result).toMatchObject({ state: 'authenticated', authMethod: 'api', summary: 'API 登录' })
    expect(result?.accountLabel).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/SECRET|old@example/)
  })

  it('reports logout from the effective store rather than any stale local identity', async () => {
    expect(await fixture(null).run()).toMatchObject({ state: 'unconfigured', verification: 'cli' })
  })

  it.each([{ error: true }, { oversized: true }])(
    'unsupported/error/oversized results safely omit identity: %j',
    async (options) => {
      const f = fixture({ type: 'chatgpt', email: 'old@example.com' }, options)
      expect(await f.run()).toBeUndefined()
      expect(f.child.terminate).toHaveBeenCalledOnce()
      expect(f.child.waitForExit).toHaveBeenCalledOnce()
    },
  )

  it('rejects unsafe email fields without losing confirmed login state', async () => {
    const value = await fixture({ type: 'chatgpt', email: 'sk-SECRET@example.com' }).run()
    expect(value?.state).toBe('authenticated')
    expect(value?.accountLabel).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain('SECRET')
  })

  it('cancels a stalled server and waits for cleanup', async () => {
    const f = fixture(null, { stall: true }),
      control = new AbortController()
    const result = f.run(control.signal)
    await new Promise<void>((resolve) => setImmediate(resolve))
    control.abort()
    await expect(result).rejects.toThrow()
    expect(f.child.terminate).toHaveBeenCalledOnce()
    expect(f.child.waitForExit).toHaveBeenCalledOnce()
  })
})
