import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/host/process.ts'
import {
  prepareHermesAccount,
  projectHermesIdentity,
  readHermesAccount,
} from '../src/host/hermes-accounts.ts'
import { verifyHermesExecutable } from '../src/host/hermes-installation.ts'

const roots: string[] = []
const signal = () => new AbortController().signal
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cliworker-hermes-account-')))
  roots.push(root)
  mkdirSync(join(root, 'project'))
  return {
    root,
    project: join(root, 'project'),
    config: { ...DEFAULT_CONFIG, stateDirectory: join(root, 'state'), hermesHome: join(root, 'native') },
  }
}
function save(home: string, name: string, value: unknown) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
}
const jwt = (claims: unknown) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
const oauth = (email = 'fixture@example.test') => ({
  version: 1,
  active_provider: 'openai-codex',
  providers: {
    'openai-codex': {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        id_token: jwt({ email }),
      },
    },
  },
})
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe('Hermes native accounts (explicit synthetic fixtures)', () => {
  it('rejects a broken fixed exec shim without running any launcher', async () => {
    const { root } = fixture(),
      shim = join(root, 'hermes')
    writeFileSync(shim, `#!/bin/sh\nexec ${join(root, 'missing-install/bin/hermes')} "$@"\n`, { mode: 0o700 })
    await expect(verifyHermesExecutable(shim, signal())).rejects.toThrow('启动入口不可用')
    writeFileSync(shim, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 })
    await expect(verifyHermesExecutable(shim, signal())).resolves.toBeUndefined()
  })
  it('does not treat a file or configuration as a logged-in account', async () => {
    const { config } = fixture()
    expect((await readHermesAccount(config, signal())).state).toBe('unconfigured')
    save(config.hermesHome, 'auth.json', { providers: {} })
    expect((await readHermesAccount(config, signal())).state).toBe('unconfigured')
    save(config.hermesHome, 'config.yaml', 'model:\n  default: fixture-model\n')
    expect(await readHermesAccount(config, signal())).toMatchObject({
      state: 'unconfigured',
      verification: 'local',
    })
    save(config.hermesHome, '.env', '# OPENAI_API_KEY=\nOPENAI_API_KEY=your_api_key_here\n')
    expect((await readHermesAccount(config, signal())).state).toBe('unconfigured')
    save(config.hermesHome, '.env', 'OPENAI_API_KEY=synthetic-secret')
    const result = await readHermesAccount(config, signal())
    expect(result.state).toBe('configured')
    expect(result.accountLabel).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/synthetic|FIXTURE_API_KEY/)
  })

  it('projects only a known native OAuth email and local verification without leaking tokens', async () => {
    const { config } = fixture()
    save(config.hermesHome, 'auth.json', oauth())
    const before = readFileSync(join(config.hermesHome, 'auth.json'), 'utf8')
    const result = await readHermesAccount(config, signal())
    expect(result).toMatchObject({
      state: 'configured',
      authMethod: 'oauth',
      verification: 'local',
      accountLabel: 'fixture@example.test',
    })
    expect(JSON.stringify(result)).not.toMatch(/synthetic|access_token|refresh_token|id_token/)
    expect(readFileSync(join(config.hermesHome, 'auth.json'), 'utf8')).toBe(before)
  })

  it('does not invent an identity from unknown OAuth shapes, arbitrary labels or unsafe emails', () => {
    expect(
      projectHermesIdentity({ providers: { unknown: { tokens: oauth().providers['openai-codex'].tokens } } })
        ?.state,
    ).toBe('configured')
    const bad = oauth('sk-secret@example.test')
    expect(projectHermesIdentity(bad)?.state).toBe('configured')
    const missingRefresh = oauth()
    missingRefresh.providers['openai-codex'].tokens.refresh_token = ''
    expect(projectHermesIdentity(missingRefresh)?.state).toBe('configured')
  })

  it('projects native xAI OAuth but never chooses among ambiguous identities', () => {
    const codex = oauth()
    const xai = { ...codex.providers['openai-codex'], auth_mode: 'oauth_device_code' }
    expect(
      projectHermesIdentity({ active_provider: 'xai-oauth', providers: { 'xai-oauth': xai } }),
    ).toMatchObject({ state: 'configured', authMethod: 'oauth', accountLabel: 'fixture@example.test' })
    expect(projectHermesIdentity({ providers: { ...codex.providers, 'xai-oauth': xai } })?.state).toBe(
      'configured',
    )
    expect(projectHermesIdentity({ ...codex, active_provider: 'unknown' })?.state).toBe('configured')
  })

  it('reports known API pool credentials as configured without exposing a key or making a remote claim', () => {
    const result = projectHermesIdentity({
      credential_pool: { fixture: [{ auth_type: 'api_key', access_token: 'synthetic-api' }] },
    })
    expect(result).toMatchObject({ state: 'configured', authMethod: 'api', verification: 'local' })
    expect(JSON.stringify(result)).not.toContain('synthetic-api')
  })

  it('keeps refresh-only OAuth unverified and reports locally expired access', () => {
    const refreshOnly = oauth()
    refreshOnly.providers['openai-codex'].tokens.access_token = ''
    expect(projectHermesIdentity(refreshOnly)?.state).toBe('configured')
    const expired = oauth()
    expired.providers['openai-codex'].tokens.access_token = jwt({ exp: 1 })
    expect(projectHermesIdentity(expired)).toMatchObject({ state: 'unauthenticated', verification: 'local' })
  })

  it.each(['invalid-json', 'symlink', 'hardlink', 'oversized'])(
    'fails closed for %s auth files',
    async (kind) => {
      const { config, root } = fixture()
      mkdirSync(config.hermesHome)
      const path = join(config.hermesHome, 'auth.json')
      if (kind === 'symlink' || kind === 'hardlink') {
        const outside = join(root, 'secret')
        save(root, 'secret', oauth())
        if (kind === 'symlink') symlinkSync(outside, path)
        else linkSync(outside, path)
      } else writeFileSync(path, kind === 'invalid-json' ? 'secret invalid {' : 'x'.repeat(65537))
      const result = await readHermesAccount(config, signal())
      expect(result.state).toBe('unavailable')
      expect(JSON.stringify(result)).not.toMatch(/secret|fixture@/)
    },
  )

  it('refuses a symlinked home and honors cancellation', async () => {
    const { root, config } = fixture()
    mkdirSync(join(root, 'other'))
    symlinkSync(join(root, 'other'), config.hermesHome)
    expect((await readHermesAccount(config, signal())).state).toBe('unavailable')
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(readHermesAccount(config, abort.signal)).rejects.toThrow('cancelled')
  })

  it('launches only native login and credential menus in disposable private working directories', async () => {
    const { config, project } = fixture()
    const login = await prepareHermesAccount('login', '/fixture/hermes', project, config, signal())
    const manage = await prepareHermesAccount('manage', '/fixture/hermes', project, config, signal())
    expect(login.argv.slice(-2)).toEqual(['/fixture/hermes', 'model'])
    expect(manage.argv.slice(-2)).toEqual(['/fixture/hermes', 'auth'])
    expect(login.argv).not.toContain('chat')
    expect(login.argv.join(' ')).toContain('private-launch.mjs')
    expect(login.argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(login.argv[2]).toContain(config.hermesHome)
    expect(login.argv[2]).not.toContain(project)
    expect(login.cwd).not.toBe(manage.cwd)
    expect(login.env).toMatchObject({
      HERMES_HOME: config.hermesHome,
      HERMES_SAFE_MODE: '1',
      HERMES_YOLO_MODE: '0',
    })
    expect(login.env).not.toHaveProperty('HOME')
    expect(Object.keys(login.env).some((key) => /API_KEY|TOKEN/.test(key))).toBe(false)
    for (const path of [login.cwd, login.env.TMPDIR!, config.hermesHome])
      expect(statSync(path).mode & 0o777).toBe(0o700)
    save(config.hermesHome, 'auth.json', oauth())
    await login.cleanup()
    await login.cleanup()
    await manage.cleanup()
    expect(existsSync(login.cwd)).toBe(false)
    expect(existsSync(manage.cwd)).toBe(false)
    expect(JSON.parse(readFileSync(join(config.hermesHome, 'auth.json'), 'utf8'))).toEqual(oauth())
  })

  it('rejects unsupported logout and cancellation before creating state', async () => {
    const { config, project } = fixture()
    await expect(
      prepareHermesAccount('logout', '/fixture/hermes', project, config, signal()),
    ).rejects.toThrow('全局退出')
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(
      prepareHermesAccount('login', '/fixture/hermes', project, config, abort.signal),
    ).rejects.toThrow('cancelled')
    expect(existsSync(config.hermesHome)).toBe(false)
    expect(existsSync(config.stateDirectory)).toBe(false)
  })

  it('rejects user home and root as writable native account storage', async () => {
    const { config, project } = fixture()
    await expect(
      prepareHermesAccount('login', '/fixture/hermes', project, { ...config, hermesHome: '/' }, signal()),
    ).rejects.toThrow('Unsafe Hermes home')
  })
})
