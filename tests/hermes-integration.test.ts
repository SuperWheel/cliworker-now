import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogFor, protocolFor } from '../src/host/adapters.ts'
import { extendedLaunch } from '../src/host/extended-adapters.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { attachTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { foldEvents, type WorkerEvent } from '../src/shared/types.ts'

vi.mock('../src/host/hermes-installation.ts', () => ({ verifyHermesExecutable: async () => undefined }))
vi.mock('../src/host/hermes-models.ts', async (load) => ({
  ...(await load<typeof import('../src/host/hermes-models.ts')>()),
  hermesAccountModels: vi.fn(async () => ({
    state: 'supported',
    source: 'account-models',
    models: [{ id: 'fixture/model', cost: 'unknown' }],
  })),
}))
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'hermes-integration-fixture-'))
  directories.push(path)
  return path
}
function nativeHome() {
  const home = directory()
  writeFileSync(
    join(home, 'config.yaml'),
    '# SYNTHETIC CONFIG\nauth:\n  adopt_external_logins: false\nmodel:\n  provider: openrouter\n  default: fixture/model\n',
  )
  return home
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

// These dispatch/receipt tests simulate CLI output. Real read-only catalog evidence lives
// in the private .test-data/hermes-catalog-real report, not in this fixture suite.
describe('Hermes dispatch and telemetry integration (synthetic fixtures)', () => {
  it('dispatches sequential sandboxed scalar catalog queries without resolving shared credentials', async () => {
    const calls: string[][] = [],
      stateDirectory = directory(),
      hermesHome = nativeHome()
    let running = false
    const resolveCredential = vi.fn(async () => 'must-not-be-used')
    const backend: ProcessBackend = {
      resolveExecutable: vi.fn(async (name) => name),
      spawn(spec) {
        expect(running).toBe(false)
        running = true
        calls.push(spec.argv)
        expect(spec.argv[0]).toBe('/usr/bin/sandbox-exec')
        expect(spec.argv[2]).toContain(realpathSync(hermesHome))
        expect(spec.env?.HERMES_HOME).toBe(realpathSync(hermesHome))
        expect(spec.env?.ZAI_CODING_CN_API_KEY).toBeUndefined()
        const field = spec.argv[spec.argv.indexOf('get') + 1]
        const stdout = (async function* () {
          yield JSON.stringify(field === 'model.default' ? 'fixture/model' : 'openrouter') + '\n'
        })()
        return {
          stdout,
          stderr: (async function* () {})(),
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: vi.fn(),
          waitForExit: async () => {
            running = false
            return true
          },
        } as ReturnType<ProcessBackend['spawn']>
      },
    }
    const catalog = await catalogFor(
      'hermes',
      backend,
      {
        ...DEFAULT_CONFIG,
        stateDirectory,
        hermesHome,
        hermesExecutable: '/synthetic/hermes',
        zaiCredentialRef: 'DO_NOT_SHARE',
        resolveCredential,
      },
      directory(),
      new AbortController().signal,
    )
    expect(catalog.models).toEqual([
      { id: '["openrouter","fixture/model"]', label: 'fixture/model', efforts: ['default'], cost: 'unknown' },
    ])
    expect(calls.map((argv) => argv[argv.indexOf('get') + 1])).toEqual(['model.default', 'model.provider'])
    expect(resolveCredential).not.toHaveBeenCalled()
  })

  it('removes obsolete Harness dispatch before a process or credential lookup', async () => {
    const backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn() }
    await expect(
      catalogFor('harness', backend, DEFAULT_CONFIG, directory(), new AbortController().signal),
    ).rejects.toThrow('已移除')
    expect(backend.resolveExecutable).not.toHaveBeenCalled()
    expect(backend.spawn).not.toHaveBeenCalled()
    expect(() =>
      protocolFor(
        'harness',
        () => {},
        () => {},
        8192,
      ),
    ).toThrow('历史记录')
  })

  it('prepares the native Hermes launch inside the project sandbox with no inherited shared credential', async () => {
    const project = directory(),
      stateDirectory = directory(),
      hermesHome = nativeHome()
    const resolveCredential = vi.fn(async () => 'must-not-be-used')
    const launch = await extendedLaunch(
      'hermes',
      '/synthetic/hermes',
      project,
      { cli: 'hermes', model: '["openrouter","fixture/model"]', effort: 'default' },
      'plan',
      'synthetic prompt',
      stateDirectory,
      { ...DEFAULT_CONFIG, stateDirectory, hermesHome, zaiCredentialRef: 'DO_NOT_SHARE', resolveCredential },
      'synthetic-session',
    )
    try {
      expect(launch.argv[0]).toBe('/usr/bin/sandbox-exec')
      expect(launch.argv[2]).not.toContain(`(subpath ${JSON.stringify(project)})`)
      expect(launch.argv).toContain('--resume')
      expect(launch.argv).toContain('synthetic-session')
      expect(launch.argv).toContain('stream-json')
      expect(launch.env.HERMES_HOME).toBe(realpathSync(hermesHome))
      expect(resolveCredential).not.toHaveBeenCalled()
    } finally {
      await launch.cleanup()
    }
  })

  it('reads real-format final tokens from a torn log and attaches them only to the correct reply/run', () => {
    const root = directory(),
      raw = join(root, 'fixture.raw.jsonl'),
      events: WorkerEvent[] = []
    const parser = protocolFor(
      'hermes',
      (event) =>
        events.push({ ...event, runId: 'run-a', seq: events.length + 1, time: '2026-10-06T02:00:00Z' }),
      () => {},
      8192,
    )
    const start = { type: 'system', subtype: 'init', session_id: 'synthetic-session', model: 'fixture/model' }
    const response = { type: 'text', text: 'synthetic reply' }
    const result = {
      type: 'result',
      session_id: 'synthetic-session',
      exit_code: 0,
      text: response.text,
      tokens: { input: 100, output: 3, total: 103, cache_read: 80, cache_write: 10 },
      duration_ms: 100,
    }
    const serialized = JSON.stringify(result)
    writeFileSync(
      raw,
      JSON.stringify(start) + '\n' + JSON.stringify(response) + '\n' + serialized.slice(0, 12),
    )
    const reader = new TelemetryReader()
    expect(reader.read(raw, 'hermes').usage).toBeUndefined()
    appendFileSync(raw, serialized.slice(12) + '\n')
    const telemetry = reader.read(raw, 'hermes')
    expect(telemetry.usage).toEqual({ total: 103, input: 100, output: 3, cacheRead: 80, scope: 'run' })
    expect(reader.read(raw, 'hermes').usage?.total).toBe(103)
    expect(telemetry.contextUsed).toBeUndefined()
    expect(telemetry.contextCapacity).toBeUndefined()
    parser.feed([start, response, result].map((event) => JSON.stringify(event)).join('\n') + '\n')
    parser.end()
    events.push({
      kind: 'assistant',
      runId: 'run-b',
      seq: 10,
      time: '2026-10-06T02:01:00Z',
      text: 'another run',
    })
    const rows = foldEvents(events)
    attachTelemetry(rows, 'run-a', telemetry)
    expect(rows.find((row) => row.text === 'synthetic reply')?.usage?.total).toBe(103)
    expect(rows.find((row) => row.text === 'another run')?.usage).toBeUndefined()
    expect(parser.result?.status).toBe('SUCCESS')
  })
})
