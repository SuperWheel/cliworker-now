import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  unlinkSync,
  chmodSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { BridgeProtocol } from '../src/host/bridge-protocol.ts'
import {
  credentialEnvironment,
  confineExtended,
  privateDirectory,
  sealPrivateTree,
  extendedLaunch,
  extendedCatalog,
} from '../src/host/extended-adapters.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { CLI_IDS } from '../src/shared/types.ts'

const filesystemRace = vi.hoisted(() => ({ beforeOpen: undefined as ((path: unknown) => void) | undefined }))
vi.mock('../src/host/pi-omp-adapter.ts', async (load) => {
  const actual = await load<typeof import('../src/host/pi-omp-adapter.ts')>()
  return {
    ...actual,
    preparePiOmp: (input: Parameters<typeof actual.preparePiOmp>[0]) =>
      actual.preparePiOmp({ ...input, nativeHome: dirname(input.accountRoot ?? input.stateDirectory) }),
  }
})
vi.mock('../src/host/zcode-adapter.ts', async (load) => {
  const actual = await load<typeof import('../src/host/zcode-adapter.ts')>()
  return {
    ...actual,
    prepareZCode: (input: Parameters<typeof actual.prepareZCode>[0]) =>
      actual.prepareZCode({
        ...input,
        nativeHome: dirname(input.stateDirectory),
        authDirectory: join(dirname(input.stateDirectory), 'synthetic-auth'),
      }),
  }
})
vi.mock('../src/host/opencode-adapter.ts', async (load) => {
  const actual = await load<typeof import('../src/host/opencode-adapter.ts')>()
  return {
    ...actual,
    discoverOpenCode: (...args: Parameters<typeof actual.discoverOpenCode>) => {
      args[5] = {
        ...args[5],
        nativeHome: join(args[2], 'synthetic-home'),
        probeOptions: {
          fetch: async (_url, request) => {
            expect(request?.method).toBe('GET')
            return Response.json({ data: [{ id: 'model' }] })
          },
        },
      }
      return actual.discoverOpenCode(...args)
    },
  }
})
function seedSyntheticOpenCode(root: string) {
  const account = join(root, 'accounts/opencode')
  const auth = join(account, 'data/opencode')
  const config = join(account, 'config/opencode')
  mkdirSync(auth, { recursive: true, mode: 0o700 })
  mkdirSync(config, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(auth, 'auth.json'),
    JSON.stringify({ fixture: { type: 'api', key: 'SYNTHETIC_ONLY' } }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(config, 'opencode.json'),
    JSON.stringify({ provider: { fixture: { options: { baseURL: 'https://synthetic.invalid/v1' } } } }),
    { mode: 0o600 },
  )
}
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      filesystemRace.beforeOpen?.(args[0])
      return fs.openSync(...args)
    },
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  filesystemRace.beforeOpen = undefined
})

it.skipIf(process.platform !== 'darwin')(
  'uses the profile account directory for a default-path worker launch without rewriting its native account',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-default-account-root-'))
    try {
      const home = join(root, 'home')
      vi.stubEnv('DSH_HOME', home)
      const account = join(home, 'cliworker-now/accounts/pi/agent')
      mkdirSync(account, { recursive: true, mode: 0o700 })
      const auth = join(account, 'auth.json')
      const original = JSON.stringify({
        'synthetic-provider': { type: 'api_key', key: 'SYNTHETIC_PLUGIN_ACCOUNT' },
      })
      writeFileSync(auth, original, { mode: 0o600 })
      const project = join(root, 'project')
      mkdirSync(project)
      // Argument preparation only: no child process or model request is started.
      const launch = await extendedLaunch(
        'pi',
        '/synthetic/pi/cli.js',
        project,
        { cli: 'pi', model: 'synthetic-provider/model', effort: 'default' },
        'plan',
        'synthetic task',
        join(root, 'worker-run'),
        DEFAULT_CONFIG,
      )
      const request = JSON.parse(readFileSync(launch.argv.at(-1)!, 'utf8'))
      const privateAuth = JSON.parse(readFileSync(join(request.stateDirectory, 'agent/auth.json'), 'utf8'))
      expect(privateAuth['synthetic-provider']?.key === 'SYNTHETIC_PLUGIN_ACCOUNT').toBe(true)
      expect(readFileSync(auth, 'utf8') === original).toBe(true)
      expect(request.accountRoot).toBe(join(home, 'cliworker-now'))
      launch.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

describe('extended worker boundaries (simulated protocol)', () => {
  it('keeps split UTF-8, identity and a real terminal receipt', () => {
    const rows: any[] = [],
      ids: string[] = []
    const p = new BridgeProtocol(
      (e) => rows.push(e),
      (id) => ids.push(id),
      2048,
    )
    const bytes = Buffer.from(
      [
        JSON.stringify({ type: 'session', id: 'native-id' }),
        JSON.stringify({ type: 'event', event: { kind: 'assistant', text: '中文', step: 0 } }),
        JSON.stringify({ type: 'result', status: 'SUCCESS', response: '中文' }),
      ].join('\n') + '\n',
    )
    for (const byte of bytes) p.feed(Buffer.from([byte]))
    p.end()
    expect(ids).toEqual(['native-id'])
    expect(rows[1].text).toBe('中文')
    expect(p.result?.status).toBe('SUCCESS')
    expect(() => p.feed('{"type":"session","id":"other"}\n')).toThrow()
  })
  it('does not invent a completion for EOF or no session identity', () => {
    const p = new BridgeProtocol(
      () => {},
      () => {},
      1000,
    )
    p.feed('{"type":"session","id":"s"}\n')
    p.end()
    expect(p.result).toBeUndefined()
    const q = new BridgeProtocol(
      () => {},
      () => {},
      1000,
    )
    expect(() => q.feed('{"type":"result","status":"SUCCESS","response":"ok"}\n')).toThrow()
  })
  it('preserves a pre-session credential failure without fabricating an identity', () => {
    const p = new BridgeProtocol(
      () => {},
      () => {},
      1000,
    )
    expect(() =>
      p.feed(
        JSON.stringify({
          type: 'result',
          status: 'ERROR',
          response: '',
          error: 'Host must provide the configured credential reference',
        }) + '\n',
      ),
    ).toThrow('configured credential reference')
    expect(p.conversationId).toBeUndefined()
  })
  it('ignores legacy Host credential references for every CLI', async () => {
    const calls: string[] = []
    const config = {
      ...DEFAULT_CONFIG,
      resolveCredential: async (ref: string) => {
        calls.push(ref)
        return 'fixture-secret'
      },
    }
    expect(await credentialEnvironment('pi', config)).toEqual({})
    expect(calls).toHaveLength(0)
    expect(
      await credentialEnvironment('grok', { ...config, zaiCredentialRef: 'ZAI_CODING_CN_API_KEY' }),
    ).toEqual({})
    expect(
      await credentialEnvironment('opencode', { ...config, zaiCredentialRef: 'ZAI_CODING_CN_API_KEY' }),
    ).toEqual({})
    for (const cli of ['pi', 'omp', 'zcode', 'hermes'] as const)
      expect(await credentialEnvironment(cli, { ...config, zaiCredentialRef: 'legacy' })).toEqual({})
    expect(calls).toEqual([])
  })
  it('hardens copied runtime data without following symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-seal-'))
    try {
      const state = join(root, 'private')
      mkdirSync(state)
      const outside = join(root, 'outside')
      writeFileSync(outside, 'sentinel', { mode: 0o644 })
      writeFileSync(join(state, 'copied'), 'native', { mode: 0o644 })
      symlinkSync(outside, join(state, 'link'))
      const before = statSync(outside).mode
      sealPrivateTree(state)
      expect(statSync(join(state, 'copied')).mode & 0o777).toBe(0o600)
      expect(statSync(state).mode & 0o777).toBe(0o700)
      expect(statSync(outside).mode).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('seals nested regular state and skips directory, broken and root symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-seal-nested-'))
    try {
      const state = join(root, 'private'),
        nested = join(state, 'nested'),
        outside = join(root, 'outside')
      mkdirSync(nested, { recursive: true })
      mkdirSync(outside)
      const native = join(nested, 'native'),
        sentinel = join(outside, 'sentinel')
      writeFileSync(native, 'runtime')
      writeFileSync(sentinel, 'external')
      chmodSync(state, 0o755)
      chmodSync(nested, 0o755)
      chmodSync(native, 0o664)
      chmodSync(outside, 0o755)
      chmodSync(sentinel, 0o644)
      symlinkSync(outside, join(state, 'directory-link'))
      symlinkSync(join(root, 'missing'), join(state, 'broken-link'))
      const rootLink = join(root, 'root-link')
      symlinkSync(outside, rootLink)
      sealPrivateTree(rootLink)
      sealPrivateTree(state)
      expect(statSync(state).mode & 0o7777).toBe(0o700)
      expect(statSync(nested).mode & 0o7777).toBe(0o700)
      expect(statSync(native).mode & 0o7777).toBe(0o600)
      expect(statSync(outside).mode & 0o7777).toBe(0o755)
      expect(statSync(sentinel).mode & 0o7777).toBe(0o644)
      expect(readFileSync(sentinel, 'utf8')).toBe('external')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('rejects a hard-linked state file without changing the external inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-seal-hardlink-'))
    try {
      const state = join(root, 'private')
      mkdirSync(state)
      const outside = join(root, 'outside'),
        linked = join(state, 'linked')
      writeFileSync(outside, 'external')
      chmodSync(outside, 0o644)
      linkSync(outside, linked)
      const before = statSync(outside)
      expect(() => sealPrivateTree(state)).toThrow('hard-linked')
      expect(statSync(outside).mode).toBe(before.mode)
      expect(statSync(outside).ino).toBe(before.ino)
      expect(statSync(linked).ino).toBe(before.ino)
      expect(readFileSync(outside, 'utf8')).toBe('external')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('does not chmod a symlink planted between inspection and open', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-seal-race-'))
    try {
      const state = join(root, 'private')
      mkdirSync(state)
      const victim = join(state, 'native'),
        outside = join(root, 'outside')
      writeFileSync(victim, 'runtime')
      writeFileSync(outside, 'external')
      chmodSync(outside, 0o644)
      filesystemRace.beforeOpen = (path) => {
        if (path !== victim) return
        filesystemRace.beforeOpen = undefined
        unlinkSync(victim)
        symlinkSync(outside, victim)
      }
      expect(() => sealPrivateTree(state)).toThrow()
      expect(statSync(outside).mode & 0o7777).toBe(0o644)
      expect(readFileSync(outside, 'utf8')).toBe('external')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform !== 'darwin')(
    'removes the short native temporary directory even when permission sealing fails',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cwn-seal-cleanup-'))
      let temporary: string | undefined
      try {
        const state = join(root, 'state'),
          project = join(root, 'project'),
          builtin = join(root, 'builtin.json')
        mkdirSync(project)
        writeFileSync(
          builtin,
          JSON.stringify({
            schemaVersion: 1,
            config: {
              providerConfigRules: {
                providerRules: [
                  {
                    providerId: 'account:bigmodel-individual-coding-plan',
                    config: {
                      builtinModelIds: ['GLM-5.3-Flash'],
                      api: { type: 'openai-chat-completions', baseUrl: 'https://example.invalid' },
                    },
                  },
                ],
              },
              modelConfigRules: {
                modelRules: [
                  {
                    modelMatch: 'GLM-5.3-Flash',
                    config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['low'] } } },
                  },
                ],
                modelApiRules: [],
                providerSiteRules: [],
                templateModelRules: [],
                builtinProviderModelRules: [],
              },
            },
          }),
        )
        // Prepare arguments only: this synthetic fixture never starts ZCode.
        const launch = await extendedLaunch(
          'zcode',
          '/synthetic/zcode.cjs',
          project,
          { cli: 'zcode', model: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash', effort: 'low' },
          'plan',
          'synthetic task',
          state,
          { ...DEFAULT_CONFIG, zcodeBuiltinConfig: builtin },
        )
        temporary = launch.env.TMPDIR
        expect(temporary && existsSync(temporary)).toBe(true)
        const outside = join(root, 'outside')
        writeFileSync(outside, 'external')
        chmodSync(outside, 0o644)
        linkSync(outside, join(state, 'hard-link'))
        expect(() => launch.cleanup()).toThrow('hard-linked')
        expect(existsSync(temporary!)).toBe(false)
        expect(statSync(outside).mode & 0o7777).toBe(0o644)
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true })
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
  it.skipIf(process.platform !== 'darwin')(
    'isolates concurrent native catalogs and seals each only after capture completes',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cwn-catalog-isolation-'))
      try {
        seedSyntheticOpenCode(root)
        const roots: string[] = []
        let release!: () => void
        const concurrent = new Promise<void>((resolve) => {
          release = resolve
        })
        const capture = async (argv: string[], env?: Record<string, string>) => {
          expect(argv.slice(-3)).toEqual(['/synthetic/opencode', 'models', '--verbose'])
          const query = dirname(env!.OPENCODE_CONFIG_DIR!)
          roots.push(query)
          const native = join(query, 'native-copied.json')
          writeFileSync(native, '{"synthetic":true}')
          chmodSync(native, 0o644)
          if (roots.length === 2) release()
          await concurrent
          expect(statSync(native).mode & 0o777).toBe(0o644)
          return (
            'fixture/model\n' +
            JSON.stringify({
              id: 'model',
              providerID: 'fixture',
              name: 'Synthetic model',
              variants: { low: {} },
            }) +
            '\n'
          )
        }
        const result = await Promise.all(
          [0, 1].map(() => extendedCatalog('opencode', '/synthetic/opencode', capture, root, DEFAULT_CONFIG)),
        )
        expect(new Set(roots).size).toBe(2)
        expect(result[0]).toEqual(result[1])
        for (const query of roots) {
          expect(query).toMatch(/\/catalog\/opencode\/query-[^/]+$/)
          expect(statSync(query).mode & 0o777).toBe(0o700)
          expect(statSync(join(query, 'native-copied.json')).mode & 0o777).toBe(0o600)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
  it.skipIf(process.platform !== 'darwin')(
    'preserves failed catalog state without sealing an unconfirmed process range',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cwn-catalog-failed-'))
      let native: string | undefined
      try {
        seedSyntheticOpenCode(root)
        const capture = async (_argv: string[], env?: Record<string, string>) => {
          native = join(dirname(env!.OPENCODE_CONFIG_DIR!), 'still-owned')
          writeFileSync(native, 'synthetic')
          chmodSync(native, 0o644)
          throw new Error('Synthetic cleanup could not confirm quiescence')
        }
        await expect(
          extendedCatalog('opencode', '/synthetic/opencode', capture, root, DEFAULT_CONFIG),
        ).rejects.toThrow('quiescence')
        expect(statSync(native!).mode & 0o777).toBe(0o644)
        expect(statSync(dirname(native!)).mode & 0o777).toBe(0o700)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
  it('migrates old CLI switches without losing disabled entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-switch-'))
    try {
      writeFileSync(
        join(root, 'cli-settings.json'),
        JSON.stringify({ enabled: { codex: false, mimo: true } }),
      )
      const storage = new WorkerStorage(root)
      const state = storage.cliSettings()
      expect(state.enabled.codex).toBe(false)
      expect(state.enabled.pi).toBe(true)
      expect(Object.keys(state.enabled).sort()).toEqual([...CLI_IDS].sort())
      storage.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform !== 'darwin')(
    'confines project writes in plan mode while permitting private CLI state',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'cwn-boundary-'))
      const state = privateDirectory(join(root, 'state')),
        project = privateDirectory(join(root, 'project'))
      try {
        const code =
          "const fs=require('fs');fs.writeFileSync(process.argv[1],'state');try{fs.writeFileSync(process.argv[2],'project');process.exit(2)}catch{}"
        const result = spawnSync(
          confineExtended(
            [process.execPath, '-e', code, join(state, 'ok'), join(project, 'forbidden')],
            state,
            project,
            'plan',
          )[0]!,
          confineExtended(
            [process.execPath, '-e', code, join(state, 'ok'), join(project, 'forbidden')],
            state,
            project,
            'plan',
          ).slice(1),
          { encoding: 'utf8' },
        )
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(join(state, 'ok'), 'utf8')).toBe('state')
        expect(existsSync(join(project, 'forbidden'))).toBe(false)
        expect(statSync(state).mode & 0o777).toBe(0o700)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
