import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ProcessBackend } from './process.ts'

/** Preserve pipes while using Harness's stronger terminal descendant ownership. */
export async function spawnManagedAgent(
  backend: ProcessBackend,
  spec: SubprocessSpawnSpec,
): Promise<SubprocessHandle> {
  // Unit-test backends can implement only pipe spawning. The production Host
  // always provides the native terminal primitive.
  // On Windows ordinary spawning owns a native Job. ConPTY does not have that
  // owner in the pinned Host, so a terminal bridge would weaken descendant cleanup.
  if (process.platform === 'win32' || !backend.spawnTerminal) return backend.spawn(spec)
  spec.signal?.throwIfAborted()
  const terminal = await backend.spawnTerminal({
    argv: [process.execPath, fileURLToPath(new URL('./terminal-bridge.mjs', import.meta.url)), ...spec.argv],
    cwd: spec.cwd,
    env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' },
    rows: 24,
    cols: 240,
    terminalType: 'dumb',
    graceMs: spec.graceMs ?? 5000,
    signal: spec.signal,
  })
  const stdout = new PassThrough(),
    stderr = new PassThrough()
  let resolve!: (outcome: SubprocessOutcome) => void, reject!: (reason: unknown) => void
  const done = new Promise<SubprocessOutcome>((yes, no) => {
    resolve = yes
    reject = no
  })
  void done.catch(() => undefined)
  let cleanup: Promise<void> | undefined,
    exited = false,
    pending = ''
  const terminate = () => {
    if (!cleanup) {
      clearInterval(observe)
      cleanup = terminal.terminate()
      void cleanup.catch((error) => reject(error))
    }
  }
  // Retain PID + start identities before agy can detach a background child.
  let inspecting = false
  const observe = setInterval(() => {
    if (inspecting || cleanup) return
    inspecting = true
    void terminal
      .inspectForeground()
      .catch((error) => {
        reject(error)
        terminate()
      })
      .finally(() => {
        inspecting = false
      })
  }, 200)
  const abort = () => terminate()
  spec.signal?.addEventListener('abort', abort, { once: true })
  if (spec.signal?.aborted) terminate()
  void (async () => {
    try {
      for await (const chunk of terminal.output) {
        pending += String(chunk)
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const text = pending.slice(0, end).trim()
          pending = pending.slice(end + 1)
          if (!text) continue
          const frame = JSON.parse(text)
          if (frame.channel === 'stdout' || frame.channel === 'stderr') {
            if (typeof frame.bytes !== 'string') throw new Error('Invalid CLI bridge bytes')
            ;(frame.channel === 'stdout' ? stdout : stderr).write(Buffer.from(frame.bytes, 'base64'))
          } else if (frame.channel === 'exit') {
            exited = true
            stdout.end()
            stderr.end()
            resolve({ exitCode: frame.exitCode, signal: frame.signal })
          } else if (frame.channel === 'error') throw new Error(frame.message)
          else throw new Error('Invalid CLI bridge frame')
        }
        if (pending.length > 2_097_152) throw new Error('CLI bridge frame too large')
      }
      if (!exited) {
        stdout.end()
        stderr.end()
        reject(new Error('CLI bridge ended before exit receipt'))
      }
    } catch (error) {
      stdout.destroy(error as Error)
      stderr.destroy(error as Error)
      reject(error)
      terminate()
    }
  })()
  void terminal.done.catch((error) => {
    stdout.destroy(error)
    stderr.destroy(error)
    reject(error)
  })
  return {
    stdin: undefined,
    stdout,
    stderr,
    control: undefined,
    collected: {},
    done,
    terminate,
    waitForExit: async () => {
      terminate()
      try {
        await cleanup
        await terminal.done
        return true
      } finally {
        spec.signal?.removeEventListener('abort', abort)
        clearInterval(observe)
      }
    },
  }
}
