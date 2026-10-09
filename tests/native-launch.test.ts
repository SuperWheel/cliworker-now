import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { nativeLaunchArgv, resolveNativeEntry } from '../src/host/native-launch.mjs'
import { nativeProcessBackend } from '../src/host/native-process.ts'
import type { ProcessBackend } from '../src/host/process.ts'

// Launcher text is synthetic. Executed subprocesses are real Node processes;
// they only echo argv, never load an account or invoke a model.
const roots: string[] = []
const directory = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-native-launch-')))
  roots.push(root)
  return root
}
function fixture(style: 'npm' | 'pnpm' = 'npm') {
  const root = directory(),
    entry = join(root, 'node_modules', 'synthetic fixture', 'cli.js')
  mkdirSync(join(root, 'node_modules', 'synthetic fixture'), { recursive: true })
  writeFileSync(entry, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const shim = join(root, 'fixture.cmd')
  writeFileSync(
    shim,
    style === 'npm'
      ? [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ')',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\synthetic fixture\\cli.js" %*',
        ].join('\r\n')
      : [
          '@IF EXIST "%~dp0\\node.exe" (',
          '  "%~dp0\\node.exe" "%~dp0\\node_modules\\synthetic fixture\\cli.js" %*',
          ') ELSE (',
          '  @SETLOCAL',
          '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
          '  node "%~dp0\\node_modules\\synthetic fixture\\cli.js" %*',
          ')',
        ].join('\r\n'),
  )
  return { root, shim, entry }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('Windows fixed native launchers', () => {
  it.each(['npm', 'pnpm'] as const)(
    'selects Bun for the actual %s Bun shim and keeps literal argv',
    (style) => {
      const f = fixture(style),
        bun = join(f.root, 'bun.exe')
      writeFileSync(bun, 'Synthetic runtime; never executed')
      writeFileSync(f.entry, '#!/usr/bin/env bun\n// Explicit synthetic Bun entry, never executed.\n')
      const nodeShim = readFileSync(f.shim, 'utf8')
      writeFileSync(
        f.shim,
        nodeShim
          .replace(/node\.exe/g, 'bun.exe')
          .replace(/_prog=node/g, '_prog=bun')
          .replace(/\bnode "/g, 'bun "'),
      )
      const args = ['--help', '中文 参数', '& literal']
      expect(nativeLaunchArgv([f.shim, ...args], 'win32')).toEqual([bun, f.entry, ...args])
      // Canonicalizing only to JS would drop a runtime pinned beside this shim.
      expect(resolveNativeEntry(f.shim, 'win32')).toBe(f.shim)
    },
  )
  it('selects Bun from the installed script shebang and package engine without substituting Node', () => {
    const f = fixture(),
      bun = join(f.root, 'bun.exe')
    writeFileSync(bun, 'Synthetic runtime; never executed')
    vi.stubEnv('PATH', f.root)
    vi.stubEnv('BUN_INSTALL', '')
    writeFileSync(f.entry, '#!/usr/bin/env bun\n// Synthetic Bun source\n')
    expect(nativeLaunchArgv([f.entry, '--version'], 'win32')).toEqual([bun, f.entry, '--version'])
    writeFileSync(f.entry, '// Synthetic published Bun bin without a shebang\n')
    writeFileSync(
      join(f.root, 'node_modules', 'synthetic fixture', 'package.json'),
      JSON.stringify({
        name: '@oh-my-pi/pi-coding-agent',
        version: '16.4.4',
        bin: { omp: 'cli.js' },
        engines: { bun: '>=1.3.14' },
      }),
    )
    expect(nativeLaunchArgv([f.entry, '--help'], 'win32')).toEqual([bun, f.entry, '--help'])
  })
  it('refuses an unknown script runtime and conflicting Node/Bun launcher declarations', () => {
    const f = fixture()
    writeFileSync(f.entry, '#!/usr/bin/env deno\n// Synthetic unsupported runtime\n')
    expect(() => nativeLaunchArgv([f.entry], 'win32')).toThrow('启动入口无法确认')
    writeFileSync(f.entry, '#!/usr/bin/env bun\n// Synthetic Bun source\n')
    expect(() => nativeLaunchArgv([f.shim], 'win32')).toThrow('启动入口无法确认')
  })
  it.each(['npm', 'pnpm'] as const)(
    'runs %s Node shim with literal argv and no shell interpretation',
    (style) => {
      const f = fixture(style),
        args = ['空格 参数', 'quote" and \\', '& echo unsafe', '$(unsafe)', '', 'line\nnext']
      const argv = nativeLaunchArgv([f.shim, ...args], 'win32')
      expect(argv).toEqual([process.execPath, realpathSync(f.entry), ...args])
      expect(resolveNativeEntry(f.shim, 'win32')).toBe(realpathSync(f.entry))
      expect(JSON.parse(execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' }))).toEqual(args)
    },
  )
  it('rejects executable batch logic, missing entries and conflicting branches', () => {
    const f = fixture()
    writeFileSync(
      f.shim,
      '@echo off\npowershell -c unsafe\nnode "%~dp0\\node_modules\\synthetic fixture\\cli.js" %*',
    )
    expect(() => nativeLaunchArgv([f.shim], 'win32')).toThrow('启动入口无法确认')
    writeFileSync(f.shim, '@echo off\nnode "%~dp0\\missing.js" %*')
    expect(() => nativeLaunchArgv([f.shim], 'win32')).toThrow()
    writeFileSync(join(f.root, 'other.js'), '// Synthetic, never executed')
    writeFileSync(
      f.shim,
      'node "%~dp0\\node_modules\\synthetic fixture\\cli.js" %*\nnode "%~dp0\\other.js" %*',
    )
    expect(() => nativeLaunchArgv([f.shim], 'win32')).toThrow('启动入口无法确认')
  })
  it('re-reads changed launcher sources instead of caching an old command', () => {
    const f = fixture()
    expect(resolveNativeEntry(f.shim, 'win32')).toBe(realpathSync(f.entry))
    writeFileSync(f.shim, '@echo off\ncall unsafe.cmd %*')
    expect(() => resolveNativeEntry(f.shim, 'win32')).toThrow('启动入口无法确认')
  })
  it('keeps the fixed official Hermes Python command and refuses general Python batch', () => {
    const root = directory(),
      shim = join(root, 'hermes.cmd'),
      python = join(root, 'python.exe')
    writeFileSync(python, 'Synthetic binary; not executed')
    const payload = Buffer.from(
      'import os, re, sys\nimport hermes_bootstrap\nfrom hermes_cli.main import main\n',
    ).toString('base64')
    const code = `import base64; exec(base64.b64decode('${payload}'))`
    writeFileSync(shim, `@echo off\r\n"${python}" -I -c "${code}" %*\r\n`)
    expect(nativeLaunchArgv([shim, 'auth', '输入 "参数"'], 'win32')).toEqual([
      python,
      '-I',
      '-c',
      code,
      'auth',
      '输入 "参数"',
    ])
    expect(resolveNativeEntry(shim, 'win32')).toBe(shim)
    writeFileSync(shim, `@echo off\n"${python}" -c "print('unsafe')" %*`)
    expect(() => nativeLaunchArgv([shim], 'win32')).toThrow('启动入口无法确认')
  })
  it('normalizes resolution, metadata pipes and terminal launch through one Host boundary', async () => {
    const f = fixture(),
      spawn = vi.fn(),
      terminal = vi.fn(async () => ({}))
    const backend = nativeProcessBackend(
      {
        resolveExecutable: async () => f.shim,
        spawn,
        spawnTerminal: terminal,
      } as unknown as ProcessBackend,
      'win32',
    )
    const entry = await backend.resolveExecutable('fixture')
    backend.spawn({
      argv: [entry, '--help'],
      cwd: f.root,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 500,
    })
    await backend.spawnTerminal!({
      argv: [f.shim, 'login'],
      cwd: f.root,
      rows: 24,
      cols: 80,
      terminalType: 'dumb',
      graceMs: 500,
    })
    expect(spawn.mock.calls[0][0].argv).toEqual([process.execPath, f.entry, '--help'])
    expect(terminal.mock.calls[0][0].argv).toEqual([process.execPath, f.entry, 'login'])
  })
  it('keeps native exe and POSIX argv, and rejects null bytes before spawn', () => {
    expect(nativeLaunchArgv(['C:\\tools\\omp.exe', '参数'], 'win32')).toEqual(['C:\\tools\\omp.exe', '参数'])
    expect(nativeLaunchArgv(['/native/cli', 'a b'], 'darwin')).toEqual(['/native/cli', 'a b'])
    expect(() => nativeLaunchArgv(['/native/cli', '\0'], 'win32')).toThrow('启动入口无法确认')
  })
  it('resolves only an actually existing supported extension for an absolute Windows entry', () => {
    const root = directory(),
      base = join(root, 'native'),
      executable = base + '.exe'
    writeFileSync(executable, 'Synthetic native executable, not executed')
    expect(resolveNativeEntry(base, 'win32')).toBe(executable)
    expect(nativeLaunchArgv([base, 'literal & argument'], 'win32')).toEqual([
      executable,
      'literal & argument',
    ])
    rmSync(executable)
    writeFileSync(base + '.ps1', 'Synthetic unsupported PowerShell entry, never executed')
    expect(resolveNativeEntry(base, 'win32')).toBe(base)
  })
})
