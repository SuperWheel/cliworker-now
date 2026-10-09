import { afterEach, describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnManagedAgent } from '../src/host/managed-agent.ts'
import { hermesNativeCommand, verifyHermesExecutable } from '../src/host/hermes-installation.ts'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
// These tests execute actual Windows OS primitives and temporary Node/Python
// programs. They do not authenticate a CLI or send model requests.

it.skipIf(process.platform !== 'win32').each(['terminate', 'abort'] as const)(
  'Windows %s uses the actual Host Job and kills a detached descendant',
  async (operation) => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    let pid: number | undefined
    const terminal = vi.spyOn(ctx.subprocess, 'spawnTerminal')
    // The provider does not publish its containment selector; its public
    // fallback warning plus real descendant quiescence are both checked.
    const warning = vi.spyOn(Reflect.get(ctx.subprocess, 'ctx').logger, 'warn')
    const controller = new AbortController()
    try {
      const handle = await spawnManagedAgent(ctx.subprocess, {
        argv: [process.execPath, resolve('tests/fixtures/detached-child.mjs')],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 500,
        signal: controller.signal,
      })
      void handle.done.catch(() => undefined)
      for await (const chunk of handle.stdout!) {
        pid = Number(String(chunk).trim())
        break
      }
      expect(pid).toBeGreaterThan(1)
      expect(terminal).not.toHaveBeenCalled()
      expect(warning.mock.calls.flat().join(' ')).not.toContain('weaker process-tree containment')
      process.kill(pid!, 0)
      if (operation === 'abort') controller.abort()
      else handle.terminate()
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
  },
  15000,
)

it.skipIf(process.platform !== 'win32')(
  'real Windows account-style ConPTY closes its own child and preserves unrelated work',
  async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    // No CLI login: both payloads are explicit Node lifecycle fixtures.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    let childPid: number | undefined
    let terminal: Awaited<ReturnType<typeof ctx.subprocess.spawnTerminal>> | undefined
    try {
      terminal = await ctx.subprocess.spawnTerminal({
        argv: [
          process.execPath,
          '-e',
          "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({fixture:'account-terminal',pid:child.pid,tty:!!process.stdin.isTTY})); process.stdin.on('data',data=>console.log('fixture-received:'+data.toString().trim())); setInterval(()=>{},1000)",
        ],
        cwd: process.cwd(),
        env: {},
        rows: 24,
        cols: 80,
        terminalType: 'dumb',
        graceMs: 500,
      })
      void terminal.done.catch(() => undefined)
      let output = ''
      const reader = (async () => {
        for await (const chunk of terminal!.output) output += String(chunk)
      })()
      void reader.catch(() => undefined)
      await vi.waitFor(
        () => {
          const record = output.match(/\{"fixture":"account-terminal","pid":(\d+),"tty":true\}/)
          expect(record).not.toBeNull()
          childPid = Number(record![1])
        },
        { timeout: 10000 },
      )
      terminal.write('safe-fixture-input\r')
      await vi.waitFor(() => expect(output).toContain('fixture-received:safe-fixture-input'), {
        timeout: 5000,
      })
      await terminal.terminate()
      await reader
      expect(() => process.kill(childPid!, 0)).toThrow()
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    } finally {
      await terminal?.terminate().catch(() => undefined)
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {}
      }
      unrelated.kill()
      await new Promise<void>((resolve) =>
        unrelated.exitCode !== null || unrelated.signalCode !== null
          ? resolve()
          : unrelated.once('exit', () => resolve()),
      )
      await ctx.fiber.dispose()
    }
  },
  25000,
)

describe.skipIf(process.platform !== 'win32')(
  'Hermes Windows official launcher contract (synthetic, real Python, no account/network)',
  () => {
    it('runs its fixed Python fallback with the recorded interpreter and literal user argv', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-windows-entry-')))
      roots.push(root)
      mkdirSync(join(root, 'hermes_cli'))
      writeFileSync(join(root, 'hermes_bootstrap.py'), '# Explicit synthetic bootstrap, no account access\n')
      writeFileSync(
        join(root, 'hermes_cli/main.py'),
        'import json,sys\ndef main():\n    print(json.dumps(sys.argv[1:]))\n',
      )
      const python =
        process.env.CLIWORKER_TEST_PYTHON ||
        execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
      const source = `import os, re, sys\nsys.path.insert(0, ${JSON.stringify(root)})\nimport hermes_bootstrap\nfrom hermes_cli.main import main\nsys.exit(main())\n`
      const code = `import base64; exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))`
      const launcher = join(root, 'hermes.cmd')
      writeFileSync(launcher, `@echo off\r\n"${python}" -I -c "${code}" %*\r\n`)
      const args = ['model', '中文 路径', '& whoami', 'literal"quote']
      const command = await hermesNativeCommand(launcher, args)
      expect(command[0]).toBe(realpathSync(python))
      expect(command.slice(-args.length)).toEqual(args)
      await expect(verifyHermesExecutable(launcher, AbortSignal.timeout(5000))).resolves.toBeUndefined()
      expect(JSON.parse(execFileSync(command[0]!, command.slice(1), { encoding: 'utf8' }))).toEqual(args)
    })
    it('preserves an actual exe without guessing a dependency directory', async () => {
      const python =
        process.env.CLIWORKER_TEST_PYTHON ||
        execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
      const command = await hermesNativeCommand(python, ['--version'])
      expect(command).toEqual([python, '--version'])
      await expect(verifyHermesExecutable(python, AbortSignal.timeout(5000))).resolves.toBeUndefined()
    })
  },
)
