import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { inspectPiInstallation } from '../src/host/pi-installation.mjs'
import { verifyPiOmpExecutable } from '../src/host/pi-omp-identity.ts'
import { executableFor, resolveCliExecutable } from '../src/host/adapters.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import { WorkerStorage } from '../src/host/storage.ts'

// Explicitly synthetic package metadata and --help. No installed CLI or account is accessed.
const roots: string[] = []
const root = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-cli-identity-')))
  roots.push(path)
  return path
}
function piPackage(directory: string, version = '1.0.4', name = '@earendil-works/pi-coding-agent') {
  mkdirSync(join(directory, 'dist/core'), { recursive: true })
  mkdirSync(join(directory, 'dist/bundle'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }))
  for (const file of ['cli.js', 'bundle/cli.js', 'index.js', 'core/model-runtime.js', 'core/auth-storage.js'])
    writeFileSync(join(directory, 'dist', file), '// Synthetic package; never executed.\n')
  return join(directory, 'dist/cli.js')
}
const ompHelp =
  'omp v16.4.4\n  setup  Native setup\n  models  Native models\n--mode rpc --config --thinking --session-dir --tools --no-rules --no-title --no-lsp --no-pty --approval-mode\n'
afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('distinct Pi and OMP entry identities', () => {
  it.each(['1.0.2', '1.0.4'])(
    'accepts the verified Pi %s package and canonicalizes its bundled launcher',
    async (version) => {
      const path = root(),
        executable = piPackage(path, version)
      const capture = vi.fn()
      expect(inspectPiInstallation(join(path, 'dist/bundle/cli.js'))).toMatchObject({ version, executable })
      expect(await verifyPiOmpExecutable('pi', executable, capture)).toBe(executable)
      expect(capture).not.toHaveBeenCalled()
    },
  )
  it('uses the current official Pi installation before an old private runtime and resolves one canonical entry', async () => {
    const home = root()
    vi.stubEnv('HOME', home)
    const bin = join(home, '.pi/agent/bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    const native = piPackage(
      join(home, '.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent'),
    )
    writeFileSync(join(home, '.pi/agent/install/current-version'), '1.0.4\n')
    writeFileSync(
      join(bin, 'pi'),
      '#!/bin/sh\n# Synthetic official launcher shape; must not execute.\n# install/current-version\nPI_MANAGED_INSTALL_ROOT=unused\nexit 91\n',
    )
    symlinkSync(join(bin, 'pi'), join(home, '.local/bin/pi'))
    piPackage(
      join(home, '.local/share/cliworker-now/runtimes/pi-1.0.2/node_modules/@earendil-works/pi-coding-agent'),
      '1.0.2',
    )
    const backend = {
      resolveExecutable: vi.fn(async (entry: string) => entry),
      spawn: vi.fn(),
    } as unknown as ProcessBackend
    expect(executableFor('pi', DEFAULT_CONFIG)).toBe(join(home, '.local/bin/pi'))
    expect(await resolveCliExecutable('pi', backend, DEFAULT_CONFIG)).toBe(native)
    expect(backend.spawn).not.toHaveBeenCalled()
  })
  it('refuses either CLI misconfigured as the other before login or model discovery', async () => {
    const pi = piPackage(root())
    const omp = piPackage(root(), '16.4.4', '@oh-my-pi/pi-coding-agent')
    const backend = {
      resolveExecutable: vi.fn(async (entry: string) => entry),
      spawn: vi.fn(),
    } as unknown as ProcessBackend
    await expect(
      resolveCliExecutable('omp', backend, { ...DEFAULT_CONFIG, ompExecutable: pi }),
    ).rejects.toThrow('OMP 入口指向 Pi')
    await expect(
      resolveCliExecutable('pi', backend, { ...DEFAULT_CONFIG, piExecutable: omp }),
    ).rejects.toThrow('Pi 安装身份')
    expect(backend.spawn).not.toHaveBeenCalled()
  })
  it('prefers a native Pi resolved on PATH and uses the legacy install only when PATH is absent', async () => {
    const home = root()
    vi.stubEnv('HOME', home)
    const legacy = piPackage(
      join(home, '.local/share/cliworker-now/runtimes/pi-1.0.2/node_modules/@earendil-works/pi-coding-agent'),
      '1.0.2',
    )
    const native = piPackage(join(home, 'native-install'))
    const backend = {
      resolveExecutable: vi.fn(async () => native),
      spawn: vi.fn(),
    } as unknown as ProcessBackend
    expect(await resolveCliExecutable('pi', backend, DEFAULT_CONFIG)).toBe(native)
    expect(backend.resolveExecutable).toHaveBeenCalledWith('pi')
    vi.mocked(backend.resolveExecutable).mockRejectedValue(
      Object.assign(new Error('Synthetic missing'), { code: 'ENOENT' }),
    )
    expect(await resolveCliExecutable('pi', backend, DEFAULT_CONFIG)).toBe(legacy)
    await expect(
      resolveCliExecutable('pi', backend, { ...DEFAULT_CONFIG, piExecutable: '/synthetic/broken' }),
    ).rejects.toThrow('Synthetic missing')
  })
  it('refuses unverified Pi versions and incomplete SDK packages instead of falling back', () => {
    const dir = root()
    const entry = piPackage(dir, '1.0.5')
    expect(() => inspectPiInstallation(entry)).toThrow('原生接口不匹配')
    piPackage(dir)
    rmSync(join(dir, 'dist/core/model-runtime.js'))
    expect(() => inspectPiInstallation(entry)).toThrow('原生接口不匹配')
  })
  it('checks OMP branding and its own capabilities with isolated --help and always removes scratch state', async () => {
    let scratch = ''
    const capture = vi.fn(async (argv: string[], cwd: string, env: Record<string, string>) => {
      expect(argv).toEqual(['/synthetic/omp', '--help'])
      expect(env.PI_CODING_AGENT_DIR).toBe(cwd)
      expect(env.OMP_PROFILE).toBe('')
      scratch = cwd
      expect(existsSync(cwd)).toBe(true)
      return ompHelp
    })
    expect(await verifyPiOmpExecutable('omp', '/synthetic/omp', capture)).toBe('/synthetic/omp')
    expect(existsSync(scratch)).toBe(false)
    await expect(
      verifyPiOmpExecutable('omp', '/synthetic/wrong', async (_argv, cwd) => {
        scratch = cwd
        return 'pi - AI coding assistant\n--mode rpc --thinking high'
      }),
    ).rejects.toThrow('OMP 安装身份')
    expect(existsSync(scratch)).toBe(false)
    await expect(
      verifyPiOmpExecutable('omp', '/synthetic/omp', async (_argv, cwd) => {
        scratch = cwd
        throw new Error('Synthetic probe failure')
      }),
    ).rejects.toThrow('Synthetic probe failure')
    expect(existsSync(scratch)).toBe(false)
  })
  it('reuses only unchanged native OMP binary capabilities and reprobes replacements', async () => {
    const directory = root()
    const executable = join(directory, 'omp')
    const alias = join(directory, 'omp-alias')
    // Synthetic ELF signature and payload, never executed.
    writeFileSync(executable, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('fixture-one')]))
    symlinkSync(executable, alias)
    const capture = vi.fn(async () => ompHelp)
    await verifyPiOmpExecutable('omp', executable, capture)
    await verifyPiOmpExecutable('omp', alias, capture)
    expect(capture).toHaveBeenCalledTimes(1)
    writeFileSync(executable, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('replacement-two')]))
    await verifyPiOmpExecutable('omp', executable, capture)
    expect(capture).toHaveBeenCalledTimes(2)
    rmSync(executable)
    writeFileSync(executable, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('replacement-two')]))
    capture.mockResolvedValueOnce('pi - unrelated CLI')
    await expect(verifyPiOmpExecutable('omp', executable, capture)).rejects.toThrow('OMP 安装身份')
    await verifyPiOmpExecutable('omp', executable, capture)
    expect(capture).toHaveBeenCalledTimes(4)
  })
  it('does not cache script launchers whose dependencies may change independently', async () => {
    const executable = join(root(), 'omp.cjs')
    writeFileSync(executable, '// Synthetic launcher, never executed.')
    const capture = vi.fn(async () => ompHelp)
    await verifyPiOmpExecutable('omp', executable, capture)
    await verifyPiOmpExecutable('omp', executable, capture)
    expect(capture).toHaveBeenCalledTimes(2)
  })
  it('preserves independent project preferences even for the same provider and model', () => {
    const directory = root()
    const storage = new WorkerStorage(join(directory, 'state'))
    const pi = { cli: 'pi' as const, model: 'provider/same-model', effort: 'high' as const }
    const omp = { cli: 'omp' as const, model: 'provider/same-model', effort: 'low' as const }
    storage.setPreference(directory, pi)
    storage.setPreference(directory, omp)
    expect(storage.preference(directory, 'pi')).toEqual(pi)
    expect(storage.preference(directory, 'omp')).toEqual(omp)
    storage.setPreference(directory, { ...pi, model: 'provider/other-model' })
    storage.close()
    const restored = new WorkerStorage(join(directory, 'state'))
    expect(restored.preference(directory, 'omp')).toEqual(omp)
    restored.close()
  })
  it('cancels an OMP probe with its caller and waits for process cleanup before removing state', async () => {
    const controller = new AbortController()
    let scratch = '',
      finish!: () => void
    const exited = new Promise<boolean>((resolve) => {
      finish = () => resolve(true)
    })
    const backend = {
      resolveExecutable: async (entry: string) => entry,
      spawn: vi.fn((spec) => {
        scratch = spec.cwd
        const stdout = new PassThrough(),
          stderr = new PassThrough()
        const done = new Promise((resolve) =>
          spec.signal.addEventListener(
            'abort',
            () => {
              stdout.end()
              stderr.end()
              resolve({ exitCode: 143 })
            },
            { once: true },
          ),
        )
        return { stdout, stderr, done, terminate: vi.fn(), waitForExit: () => exited }
      }),
    } as unknown as ProcessBackend
    let settled = false
    const pending = resolveCliExecutable(
      'omp',
      backend,
      { ...DEFAULT_CONFIG, ompExecutable: '/synthetic/omp' },
      controller.signal,
    )
    const checked = expect(pending).rejects.toThrow('Synthetic cancelled')
    void pending.catch(() => {
      settled = true
    })
    await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledOnce())
    controller.abort(new Error('Synthetic cancelled'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(existsSync(scratch)).toBe(true)
    finish()
    await checked
    expect(existsSync(scratch)).toBe(false)
  })
  it('retains probe state when process cleanup is unconfirmed', async () => {
    let scratch = ''
    await expect(
      verifyPiOmpExecutable('omp', '/synthetic/omp', async (_argv, cwd) => {
        scratch = cwd
        roots.push(cwd)
        throw new ProcessCleanupUnconfirmedError()
      }),
    ).rejects.toBeInstanceOf(ProcessCleanupUnconfirmedError)
    expect(existsSync(scratch)).toBe(true)
  })
  it('does not start a late probe after path resolution was cancelled', async () => {
    let resolved!: (path: string) => void
    const controller = new AbortController()
    const backend = {
      resolveExecutable: () =>
        new Promise<string>((resolve) => {
          resolved = resolve
        }),
      spawn: vi.fn(),
    } as unknown as ProcessBackend
    const pending = resolveCliExecutable(
      'omp',
      backend,
      { ...DEFAULT_CONFIG, ompExecutable: '/synthetic/omp' },
      controller.signal,
    )
    controller.abort(new Error('Synthetic cancelled'))
    await expect(pending).rejects.toThrow('Synthetic cancelled')
    resolved('/synthetic/omp')
    await new Promise((resolve) => setImmediate(resolve))
    expect(backend.spawn).not.toHaveBeenCalled()
  })
})
