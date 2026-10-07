import { expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { captureCatalogMetadata } from '../src/host/adapters.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'

// Synthetic process boundaries only: no native CLI, credentials or network.
function fixture(wait: () => Promise<boolean>) {
  const stdout = new PassThrough(),
    stderr = new PassThrough()
  stdout.end('[]')
  stderr.end()
  const child: SubprocessHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control: undefined,
    collected: {},
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(wait),
  }
  const backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn(() => child) }
  const run = (signal = new AbortController().signal) =>
    captureCatalogMetadata(
      backend,
      DEFAULT_CONFIG,
      ['/synthetic/native-metadata'],
      '/synthetic/project',
      signal,
    )
  return { backend, child, run }
}

it('rejects metadata success when its process range has not exited', async () => {
  const f = fixture(async () => false)
  await expect(f.run()).rejects.toBeInstanceOf(ProcessCleanupUnconfirmedError)
  expect(f.child.terminate).toHaveBeenCalledOnce()
  expect(f.child.waitForExit).toHaveBeenCalledOnce()
})

it('preserves typed cleanup failure without exposing driver diagnostics', async () => {
  const f = fixture(async () => {
    throw new Error('SYNTHETIC_PRIVATE_DRIVER_DIAGNOSTIC')
  })
  let failure: unknown
  try {
    await f.run()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(ProcessCleanupUnconfirmedError)
  expect(String(failure)).toBe(
    'ProcessCleanupUnconfirmedError: CLI catalog process cleanup did not reach quiescence',
  )
  expect(String(failure)).not.toContain('SYNTHETIC_PRIVATE_DRIVER_DIAGNOSTIC')
})

it('does not spawn metadata for an already cancelled request', async () => {
  const f = fixture(async () => true)
  const controller = new AbortController()
  controller.abort(new Error('Synthetic caller cancelled'))
  await expect(f.run(controller.signal)).rejects.toThrow('Synthetic caller cancelled')
  expect(f.backend.spawn).not.toHaveBeenCalled()
})
