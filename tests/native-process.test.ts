import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { resolve } from 'node:path'
import { spawnManagedAgent } from '../src/host/managed-agent.ts'

it('native terminal ownership removes a real child in a separate process group', async () => {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  let pid: number | undefined
  try {
    const handle = await spawnManagedAgent(ctx.subprocess, {
      argv: [process.execPath, resolve('tests/fixtures/detached-child.mjs')],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 500,
    })
    void handle.done.catch(() => undefined)
    for await (const chunk of handle.stdout!) {
      pid = Number(String(chunk).trim())
      break
    }
    expect(pid).toBeGreaterThan(1)
    process.kill(pid!, 0)
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await ctx.fiber.dispose()
  }
}, 15000)
