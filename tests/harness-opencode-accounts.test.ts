import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DEFAULT_CONFIG } from '../src/host/process.ts'
import {
  readPiOmpAccount,
  readOpenCodeAccount,
  prepareOpenCodeAccount,
} from '../src/host/harness-opencode-accounts.ts'
import { discoverOpenCode, openCodeAuthDirectory, prepareOpenCode } from '../src/host/opencode-adapter.ts'
import { extendedLaunch, extendedCatalog } from '../src/host/extended-adapters.ts'

// Every native source and network response in this suite is synthetic.
vi.mock('../src/host/pi-omp-native.ts', async (load) => {
  const original = await load<typeof import('../src/host/pi-omp-native.ts')>()
  return {
    ...original,
    inspectPiOmpNativeAccount: (cli: 'pi' | 'omp', root: string, signal: AbortSignal) =>
      original.inspectPiOmpNativeAccount(cli, root, signal, { nativeHome: join(root, 'test-native') }),
  }
})
vi.mock('../src/host/opencode-native.ts', async (load) => {
  const original = await load<typeof import('../src/host/opencode-native.ts')>()
  return {
    ...original,
    readOpenCodeProfile: (dir: string, options = {}) =>
      original.readOpenCodeProfile(dir, { nativeHome: join(dir, 'test-native'), ...options }),
    inspectOpenCodeProfile: (dir: string, options = {}) =>
      original.inspectOpenCodeProfile(dir, { nativeHome: join(dir, 'test-native'), ...options }),
  }
})
vi.mock('../src/host/account-models.mjs', async (load) => {
  const original = await load<typeof import('../src/host/account-models.mjs')>()
  return {
    ...original,
    probeAccountModels: (input: any, options: any) =>
      original.probeAccountModels(input, {
        ...options,
        fetch: async () => new Response(JSON.stringify({ data: [{ id: 'model' }, { id: 'glm-5.3-flash' }] })),
      }),
  }
})
function seedAccount(config: ReturnType<typeof fixture>) {
  const auth = openCodeAuthDirectory(config.stateDirectory),
    home = join(auth, 'test-native')
  mkdirSync(join(auth, 'opencode'), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(auth, 'opencode/auth.json'),
    JSON.stringify({ fixture: { type: 'api', key: 'synthetic-key' } }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(home, '.config/opencode/opencode.json'),
    JSON.stringify({
      provider: { fixture: { options: { baseURL: 'https://example.test' }, models: { model: {} } } },
    }),
    { mode: 0o600 },
  )
}
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cwn-account-fixture-'))
  roots.push(root)
  return { ...DEFAULT_CONFIG, stateDirectory: root }
}
const signal = () => new AbortController().signal
const catalog =
  'fixture/model\n' + JSON.stringify({ id: 'model', providerID: 'fixture', variants: {} }) + '\n'
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('Managed API/OpenCode accounts (explicit synthetic fixtures)', () => {
  it('keeps account management in its own plugin store without copying a global native OAuth login', async () => {
    const config = fixture(),
      data = openCodeAuthDirectory(config.stateDirectory)
    const native = join(data, 'test-native/.local/share/opencode')
    mkdirSync(native, { recursive: true })
    const path = join(native, 'auth.json')
    const raw = JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'SYNTHETIC-ACCESS',
        refresh: 'SYNTHETIC-REFRESH',
        expires: Date.now() + 3600000,
        accountId: 'synthetic-account',
      },
    })
    writeFileSync(path, raw, { mode: 0o600 })
    expect(await readOpenCodeAccount(config, signal())).toMatchObject({
      state: 'authenticated',
      authMethod: 'oauth',
    })
    const terminal = await prepareOpenCodeAccount('/bin/opencode', 'login', config, signal())
    expect(terminal.env.XDG_DATA_HOME).toBe(data)
    expect(existsSync(join(data, 'opencode/auth.json'))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(raw)
    terminal.cleanup()
  })

  it('keeps independent native account status when a shared Host API reference exists', async () => {
    const config = {
      ...fixture(),
      zaiCredentialRef: 'synthetic-ref',
      resolveCredential: async () => 'synthetic-secret',
    }
    const state = await readPiOmpAccount('pi', config, signal())
    expect(state).toMatchObject({
      state: 'unconfigured',
      verification: 'local',
      summary: '尚未配置原生账号',
    })
    expect(await readOpenCodeAccount(config, signal())).toMatchObject({
      state: 'unconfigured',
    })
    expect(JSON.stringify(state)).not.toContain('synthetic-')
    expect(
      await readPiOmpAccount('pi', { ...config, resolveCredential: async () => undefined }, signal()),
    ).toMatchObject({ state: 'unconfigured', summary: '尚未配置原生账号' })
    const failed = await readPiOmpAccount(
      'pi',
      {
        ...config,
        resolveCredential: async () => {
          throw new Error('synthetic-secret')
        },
      },
      signal(),
    )
    expect(failed.state).toBe('unconfigured')
    expect(JSON.stringify(failed)).not.toContain('synthetic-secret')
    const native = join(config.stateDirectory, 'test-native/.pi/agent')
    mkdirSync(native, { recursive: true })
    writeFileSync(
      join(native, 'auth.json'),
      JSON.stringify({ fixture: { type: 'oauth', access: 'synthetic-expired', expires: 1 } }),
    )
    expect(await readPiOmpAccount('pi', config, signal())).toMatchObject({ state: 'unauthenticated' })
    expect(await readPiOmpAccount('omp', config, signal())).toMatchObject({ state: 'unconfigured' })
  })
  it('reads native credentials only from the same stable profile data root and never projects OAuth tokens', async () => {
    const config = fixture(),
      path = join(openCodeAuthDirectory(config.stateDirectory), 'opencode')
    expect(await readOpenCodeAccount(config, signal())).toMatchObject({ state: 'unconfigured' })
    mkdirSync(path, { recursive: true })
    const file = join(path, 'auth.json')
    writeFileSync(
      file,
      JSON.stringify({
        fixture: {
          type: 'oauth',
          access: 'synthetic-access',
          refresh: 'synthetic-refresh',
          expires: Date.now() + 120000,
          accountId: 'private-id',
        },
      }),
    )
    const state = await readOpenCodeAccount(config, signal())
    expect(state).toMatchObject({ state: 'authenticated', authMethod: 'oauth', verification: 'local' })
    expect(state.accountLabel).toBeUndefined()
    expect(JSON.stringify(state)).not.toMatch(/synthetic|private-id/)
    expect(JSON.parse(readFileSync(file, 'utf8')).fixture.expires).toBeGreaterThan(Date.now())
    writeFileSync(file, '{}')
    expect(await readOpenCodeAccount(config, signal())).toMatchObject({ state: 'unconfigured' })
  })
  it('sanitizes malformed auth data and refuses to follow a planted auth link', async () => {
    const config = fixture(),
      path = join(openCodeAuthDirectory(config.stateDirectory), 'opencode')
    mkdirSync(path, { recursive: true })
    const outside = join(config.stateDirectory, 'private-sentinel')
    writeFileSync(outside, '{"provider":{"type":"api","key":"synthetic-secret"}}')
    symlinkSync(outside, join(path, 'auth.json'))
    const state = await readOpenCodeAccount(config, signal())
    expect(state.state).toBe('unavailable')
    expect(JSON.stringify(state)).not.toContain('synthetic-secret')
  })
  it('keeps unsupported metadata unknown but reports expired non-refreshable OAuth separately', async () => {
    const config = fixture(),
      path = join(openCodeAuthDirectory(config.stateDirectory), 'opencode')
    mkdirSync(path, { recursive: true })
    const file = join(path, 'auth.json')
    writeFileSync(file, JSON.stringify({ fixture: { type: 'future', secret: 'synthetic-secret' } }))
    expect(await readOpenCodeAccount(config, signal())).toMatchObject({ state: 'unknown' })
    writeFileSync(
      file,
      JSON.stringify({ fixture: { type: 'oauth', access: 'synthetic-secret', refresh: '', expires: 1 } }),
    )
    const expired = await readOpenCodeAccount(config, signal())
    expect(expired).toMatchObject({ state: 'unauthenticated', summary: expect.stringContaining('已过期') })
    expect(JSON.stringify(expired)).not.toContain('synthetic-secret')
    writeFileSync(
      file,
      JSON.stringify({
        fixture: { type: 'oauth', access: 'synthetic-secret', refresh: '', expires: Date.now() + 60000 },
      }),
    )
    expect(await readOpenCodeAccount(config, signal())).toMatchObject({
      state: 'authenticated',
      verification: 'local',
    })
  })
  it('shares native login auth with workers/catalogs while keeping DB and config independent', async () => {
    const config = fixture(),
      auth = openCodeAuthDirectory(config.stateDirectory)
    seedAccount(config)
    const login = await prepareOpenCodeAccount('/bin/opencode', 'login', config, signal())
    expect(login.argv.slice(-3)).toEqual(['/bin/opencode', 'auth', 'login'])
    const worker = await prepareOpenCode({
      executable: '/bin/opencode',
      project: config.stateDirectory,
      stateDirectory: join(config.stateDirectory, 'native', 'worker'),
      authDirectory: auth,
      preference: { model: 'fixture/model', effort: 'default' },
      mode: 'plan',
      prompt: 'synthetic task',
    })
    let catalogEnv: Record<string, string> | undefined
    await discoverOpenCode(
      '/bin/opencode',
      async (_argv, env) => {
        catalogEnv = env
        return catalog
      },
      join(config.stateDirectory, 'catalog-fixture'),
      auth,
    )
    for (const env of [login.env, worker.env, catalogEnv!]) {
      expect(env.XDG_DATA_HOME).toContain(auth)
      expect(env.OPENCODE_AUTH_CONTENT).toBe('')
      expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('0')
      expect(env.OPENCODE_PURE).toBe('1')
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    }
    expect(new Set([login.env.OPENCODE_DB, worker.env.OPENCODE_DB, catalogEnv!.OPENCODE_DB]).size).toBe(3)
    expect(statSync(auth).mode & 0o777).toBe(0o700)
    expect(JSON.parse(login.env.OPENCODE_PERMISSION!)).toEqual({ '*': 'deny' })
    const nativeConfig = JSON.parse(login.env.OPENCODE_CONFIG_CONTENT!)
    expect(nativeConfig).not.toHaveProperty('model')
    expect(nativeConfig).not.toHaveProperty('small_model')
    expect(nativeConfig).not.toHaveProperty('enabled_providers')
    login.cleanup()
  })
  it('never resolves a Host source for terminals, tasks or catalogs', async () => {
    const resolveCredential = vi.fn(async () => 'synthetic-host-key')
    const config = { ...fixture(), zaiCredentialRef: 'synthetic-ref', resolveCredential }
    for (const action of ['login', 'logout', 'manage'] as const) {
      const native = await prepareOpenCodeAccount('/bin/opencode', action, config, signal())
      expect(native.env.ZHIPU_API_KEY).toBeUndefined()
      expect(native.env.OPENCODE_AUTH_CONTENT).toBe('')
      expect(JSON.parse(native.env.OPENCODE_CONFIG_CONTENT!)).not.toHaveProperty('model')
      native.cleanup()
    }
    const capture = vi.fn()
    expect(
      await extendedCatalog('opencode', '/bin/opencode', capture, config.stateDirectory, config),
    ).toEqual([])
    expect(capture).not.toHaveBeenCalled()
    await expect(
      extendedLaunch(
        'opencode',
        '/bin/opencode',
        config.stateDirectory,
        { cli: 'opencode', model: 'zhipuai-coding-plan/glm-5.3-flash', effort: 'default' },
        'plan',
        'synthetic task',
        join(config.stateDirectory, 'native', 'one'),
        config,
      ),
    ).rejects.toThrow('没有有效账号')
    expect(resolveCredential).not.toHaveBeenCalled()
    seedAccount(config)
    const worker = await extendedLaunch(
      'opencode',
      '/bin/opencode',
      config.stateDirectory,
      { cli: 'opencode', model: 'fixture/model', effort: 'default' },
      'plan',
      'synthetic task',
      join(config.stateDirectory, 'native', 'two'),
      config,
    )
    expect(worker.env.ZHIPU_API_KEY).toBeUndefined()
    expect(readFileSync(join(worker.env.XDG_DATA_HOME!, 'opencode/auth.json'), 'utf8')).toContain(
      'synthetic-key',
    )
    worker.cleanup()
    expect(resolveCredential).not.toHaveBeenCalled()
  })
  it('observes cancellation before preparing a terminal or reading an account', async () => {
    const config = fixture(),
      controller = new AbortController()
    controller.abort(new Error('synthetic cancelled'))
    await expect(prepareOpenCodeAccount('/bin/opencode', 'login', config, controller.signal)).rejects.toThrow(
      'synthetic cancelled',
    )
    await expect(readPiOmpAccount('pi', config, controller.signal)).rejects.toThrow('synthetic cancelled')
  })
  it('removes only private terminal runtime data after exit, leaving shared auth and worker data intact', async () => {
    const config = fixture()
    const terminal = await prepareOpenCodeAccount('/bin/opencode', 'login', config, signal())
    const auth = openCodeAuthDirectory(config.stateDirectory)
    const credentials = join(auth, 'opencode', 'auth.json')
    writeFileSync(credentials, '{"fixture":{"type":"api","key":"synthetic-secret"}}')
    const worker = join(config.stateDirectory, 'native', 'one')
    mkdirSync(worker, { recursive: true })
    writeFileSync(join(worker, 'session.json'), 'synthetic-session')
    symlinkSync(auth, join(terminal.cwd, 'nested-auth-link'))
    terminal.cleanup()
    terminal.cleanup()
    expect(existsSync(terminal.cwd)).toBe(false)
    expect(readFileSync(credentials, 'utf8')).toContain('synthetic-secret')
    expect(readFileSync(join(worker, 'session.json'), 'utf8')).toBe('synthetic-session')
  })
  it('cleans allocated runtime after environment failure without touching a shared-auth symlink target', async () => {
    const config = fixture(),
      auth = openCodeAuthDirectory(config.stateDirectory)
    mkdirSync(auth, { recursive: true })
    const outside = join(config.stateDirectory, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel'), 'untouched')
    symlinkSync(outside, join(auth, 'opencode'))
    await expect(prepareOpenCodeAccount('/bin/opencode', 'login', config, signal())).rejects.toThrow(
      'symlink',
    )
    expect(readdirSync(join(config.stateDirectory, 'accounts', 'opencode', 'terminals'))).toEqual([])
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('untouched')
  })
  it('a stalled Host resolver cannot block native account management', async () => {
    const config = fixture(),
      resolver = vi.fn(() => new Promise<string>(() => {}))
    const terminal = await prepareOpenCodeAccount(
      '/bin/opencode',
      'manage',
      { ...config, zaiCredentialRef: 'fixture', resolveCredential: resolver },
      signal(),
    )
    expect(resolver).not.toHaveBeenCalled()
    terminal.cleanup()
    expect(existsSync(terminal.cwd)).toBe(false)
  })
  it.skipIf(process.platform !== 'darwin')(
    'permits native OAuth refresh in shared data while denying plan project writes',
    async () => {
      const config = fixture(),
        project = join(config.stateDirectory, 'project')
      mkdirSync(project)
      seedAccount(config)
      const launch = await extendedLaunch(
        'opencode',
        '/bin/opencode',
        project,
        { cli: 'opencode', model: 'fixture/model', effort: 'default' },
        'plan',
        'synthetic task',
        join(config.stateDirectory, 'native', 'one'),
        config,
      )
      const authFile = join(
        openCodeAuthDirectory(config.stateDirectory),
        'opencode',
        'synthetic-refresh.json',
      )
      const denied = join(project, 'forbidden')
      const code =
        "const fs=require('fs');fs.writeFileSync(process.argv[1],'synthetic-refresh');try{fs.writeFileSync(process.argv[2],'project');process.exit(2)}catch{}"
      const outcome = spawnSync(
        launch.argv[0]!,
        [...launch.argv.slice(1, 3), process.execPath, '-e', code, authFile, denied],
        { encoding: 'utf8' },
      )
      expect(outcome.status, outcome.stderr).toBe(0)
      expect(readFileSync(authFile, 'utf8')).toBe('synthetic-refresh')
      expect(existsSync(denied)).toBe(false)
      launch.cleanup()
    },
  )
})
