import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DEFAULT_CONFIG, type ProcessBackend, type RuntimeConfig } from '../src/host/process.ts'
import { zcodeAuthDirectory, zcodeEnvironment } from '../src/host/zcode-adapter.ts'
import {
  projectZCodeIdentity,
  projectGrokIdentity,
  supportsBigModelLogin,
  zcodeGrokAccountLaunch,
  zcodeGrokAccountStatus,
} from '../src/host/zcode-grok-accounts.ts'

// All help, auth files and paths are synthetic. No native account is read or changed.
const roots: string[] = []
const launcher = fileURLToPath(new URL('../src/host/private-launch.mjs', import.meta.url))
const wrapped = (argv: string[]) => [process.execPath, launcher, ...argv]
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(help = 'zcode 0.16.9\n  login [zai|bigmodel]  Sign in through browser authorization\n') {
  const home = mkdtempSync(join(tmpdir(), 'cwn-zg-account-'))
  roots.push(home)
  const stateDirectory = join(home, 'state')
  const builtin = join(home, 'builtin.json')
  writeFileSync(builtin, '{}')
  const config: RuntimeConfig = { ...DEFAULT_CONFIG, stateDirectory, zcodeBuiltinConfig: builtin }
  const children: SubprocessHandle[] = []
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(),
    spawn: vi.fn(() => {
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let finish!: (value: SubprocessOutcome) => void
      const done = new Promise<SubprocessOutcome>((resolve) => {
        finish = resolve
      })
      const child: SubprocessHandle = {
        stdin: undefined,
        stdout,
        stderr,
        control: undefined,
        collected: {},
        done,
        terminate: vi.fn(() => {
          stdout.end()
          stderr.end()
          finish({ exitCode: 0, signal: null })
        }),
        waitForExit: vi.fn(async () => true),
      }
      queueMicrotask(() => {
        stdout.end(help)
        stderr.end('SYNTHETIC-SECRET-ERROR')
        finish({ exitCode: 0, signal: null })
      })
      children.push(child)
      return child
    }),
  }
  const signal = new AbortController().signal
  return { home, config, stateDirectory, backend, children, signal }
}

describe('ZCode/Grok user-operated account helpers', () => {
  it.each(['login', 'logout', 'manage'] as const)(
    'passes the existing cipher secret only to the ZCode %s environment',
    async (action) => {
      const f = fixture()
      const secret = 'SYNTHETIC_ACCOUNT_CIPHER_SECRET'
      vi.stubEnv('ZCODE_CREDENTIAL_SECRET', ` ${secret} `)
      const launch = await zcodeGrokAccountLaunch(
        'zcode',
        action,
        '/synthetic/zcode.cjs',
        f.config,
        f.backend,
        f.signal,
        f,
      )
      expect(launch.env.ZCODE_CREDENTIAL_SECRET).toBe(secret)
      expect(JSON.stringify(launch.argv)).not.toContain(secret)
      expect(launch.instruction).not.toContain(secret)
      const grok = await zcodeGrokAccountLaunch(
        'grok',
        action,
        '/synthetic/grok',
        f.config,
        f.backend,
        f.signal,
        f,
      )
      expect(grok.env).not.toHaveProperty('ZCODE_CREDENTIAL_SECRET')
      vi.stubEnv('ZCODE_CREDENTIAL_SECRET', '   ')
      expect(
        zcodeEnvironment(
          '/synthetic/zcode.cjs',
          join(f.home, 'empty-secret'),
          undefined,
          f.config.zcodeBuiltinConfig,
        ),
      ).not.toHaveProperty('ZCODE_CREDENTIAL_SECRET')
    },
  )
  it('uses the same native Grok auth source as workers, with only verified action arguments', async () => {
    const f = fixture()
    for (const action of ['login', 'logout', 'manage'] as const) {
      const launch = await zcodeGrokAccountLaunch(
        'grok',
        action,
        '/synthetic/grok',
        f.config,
        f.backend,
        f.signal,
        f,
      )
      expect(launch.argv).toEqual(wrapped(['/synthetic/grok', ...(action === 'manage' ? [] : [action])]))
      expect(launch.env.GROK_HOME).toBe(join(f.home, '.grok'))
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(launch.cwd).toBe(join(f.stateDirectory, 'accounts/grok-terminal/workspace'))
      expect(launch.argv).not.toContain('--single')
      expect(launch.instruction).toContain('Grok')
    }
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })

  it('preserves explicit ZCode auth and matches task auth while keeping session storage private', async () => {
    const f = fixture()
    f.config = { ...f.config, zcodeAuthDirectory: join(f.home, 'chosen-auth') }
    const launch = await zcodeGrokAccountLaunch(
      'zcode',
      'login',
      '/synthetic/zcode.cjs',
      f.config,
      f.backend,
      f.signal,
      f,
    )
    expect(launch.argv).toEqual(wrapped([process.execPath, '/synthetic/zcode.cjs', 'login', 'bigmodel']))
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(launch.env.ZCODE_DATA_BASE_DIR).toBe(join(f.home, 'chosen-auth'))
    const task = zcodeEnvironment(
      '/synthetic/zcode.cjs',
      join(f.home, 'worker'),
      zcodeAuthDirectory(f.config.zcodeAuthDirectory, f.stateDirectory),
      f.config.zcodeBuiltinConfig,
    )
    expect(task.ZCODE_DATA_BASE_DIR).toBe(launch.env.ZCODE_DATA_BASE_DIR)
    expect(task.ZCODE_SESSION_DB_PATH).not.toBe(launch.env.ZCODE_SESSION_DB_PATH)
    expect(vi.mocked(f.backend.spawn).mock.calls[0]![0].argv).toEqual([
      process.execPath,
      '/synthetic/zcode.cjs',
      '--help',
    ])
    expect(f.children[0]?.terminate).toHaveBeenCalledOnce()
    expect(f.children[0]?.waitForExit).toHaveBeenCalledOnce()
  })

  it('shares default ZCode auth across workers and account actions without project coupling', async () => {
    const f = fixture()
    for (const action of ['logout', 'manage'] as const) {
      const launch = await zcodeGrokAccountLaunch(
        'zcode',
        action,
        '/synthetic/zcode',
        f.config,
        f.backend,
        f.signal,
        f,
      )
      expect(launch.argv).toEqual(wrapped(['/synthetic/zcode', action === 'manage' ? 'tui' : 'logout']))
      expect(launch.env.ZCODE_DATA_BASE_DIR).toBe(zcodeAuthDirectory(undefined, f.stateDirectory))
      expect(launch.env.ZCODE_DATA_BASE_DIR).toBe(join(f.stateDirectory, 'accounts/zcode'))
      if (action === 'logout') expect(launch.instruction).toContain('Z.AI 和 BigModel')
    }
  })

  it('rejects the same-version incomplete Desktop build before attempting any auth command', async () => {
    const f = fixture(
      'zcode 0.16.9\n  login      Sign in with Z.AI OAuth for model access\n  tui  Open terminal\n',
    )
    await expect(
      zcodeGrokAccountLaunch('zcode', 'login', '/synthetic/bundled.cjs', f.config, f.backend, f.signal, f),
    ).rejects.toThrow('完整 ZCode CLI')
    expect(vi.mocked(f.backend.spawn).mock.calls).toHaveLength(1)
    expect(vi.mocked(f.backend.spawn).mock.calls[0]![0].argv.at(-1)).toBe('--help')
    expect(supportsBigModelLogin('0.16.9')).toBe(false)
  })

  it('bounds capability responses, cleans up, and never reports raw CLI output', async () => {
    const f = fixture('SECRET'.repeat(12_000))
    const failure = await zcodeGrokAccountLaunch(
      'zcode',
      'manage',
      '/synthetic/zcode.cjs',
      f.config,
      f.backend,
      f.signal,
      f,
    ).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('SECRET')
    expect(f.children[0]?.terminate).toHaveBeenCalledOnce()
    expect(f.children[0]?.waitForExit).toHaveBeenCalledOnce()
  })

  it('malformed credentials report read errors and never leak content', async () => {
    const f = fixture()
    for (const cli of ['zcode', 'grok'] as const) {
      const directory =
        cli === 'zcode' ? join(f.stateDirectory, 'accounts/zcode/.zcode/v2') : join(f.home, '.grok')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, cli === 'zcode' ? 'credentials.json' : 'auth.json')
      writeFileSync(path, 'SECRET-CREDENTIAL-CONTENTS', { mode: 0o600 })
      const status = await zcodeGrokAccountStatus(cli, f.config, f.signal, f)
      expect(status).toMatchObject({ state: 'unavailable', verification: 'local' })
      expect(status.accountLabel).toBeUndefined()
      expect(status.authMethod).toBeUndefined()
      expect(JSON.stringify(status)).not.toContain('SECRET')
      rmSync(path)
      expect((await zcodeGrokAccountStatus(cli, f.config, f.signal, f)).state).toBe('unconfigured')
    }
  })

  it('does not follow linked or empty credential files or leak filesystem errors', async () => {
    const f = fixture()
    mkdirSync(join(f.home, '.grok'))
    const path = join(f.home, '.grok/auth.json'),
      target = join(f.home, 'SECRET-target')
    writeFileSync(target, 'SECRET')
    symlinkSync(target, path)
    expect((await zcodeGrokAccountStatus('grok', f.config, f.signal, f)).state).toBe('unavailable')
    rmSync(path)
    writeFileSync(path, '')
    const status = await zcodeGrokAccountStatus('grok', f.config, f.signal, f)
    expect(status.state).toBe('unavailable')
    expect(JSON.stringify(status)).not.toContain('SECRET')
  })
  it('projects native personal API configuration only when the OAuth account is absent', async () => {
    const f = fixture(),
      native = join(f.home, '.zcode/v2')
    mkdirSync(native, { recursive: true })
    const path = join(native, 'provider_config.json')
    const config: any = {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'synthetic-api',
              config: { access: { type: 'api-key', apiKey: 'SYNTHETIC_SECRET' } },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const before = readFileSync(path, 'utf8')
    const status = await zcodeGrokAccountStatus('zcode', f.config, f.signal, f)
    expect(status).toMatchObject({
      state: 'configured',
      authMethod: 'api',
      verification: 'local',
      summary: expect.stringContaining('未进行远程验证'),
    })
    expect(status.accountLabel).toBeUndefined()
    expect(JSON.stringify(status)).not.toContain('SYNTHETIC_SECRET')
    expect(readFileSync(path, 'utf8')).toBe(before)
    config.config.providerConfigRules.providerRules[0].config.access.apiKey = ''
    writeFileSync(path, JSON.stringify(config))
    expect((await zcodeGrokAccountStatus('zcode', f.config, f.signal, f)).state).toBe('unconfigured')
    config.config.providerConfigRules.providerRules[0].config.access.type = 'future'
    writeFileSync(path, JSON.stringify(config))
    expect((await zcodeGrokAccountStatus('zcode', f.config, f.signal, f)).state).toBe('unknown')
    writeFileSync(path, 'SYNTHETIC_SECRET invalid {')
    const failed = await zcodeGrokAccountStatus('zcode', f.config, f.signal, f)
    expect(failed.state).toBe('unavailable')
    expect(JSON.stringify(failed)).not.toContain('SYNTHETIC_SECRET')
  })

  it('cancellation prevents both auth file checks and CLI capability spawn', async () => {
    const f = fixture(),
      controller = new AbortController()
    controller.abort()
    await expect(zcodeGrokAccountStatus('grok', f.config, controller.signal, f)).rejects.toThrow()
    await expect(
      zcodeGrokAccountLaunch('zcode', 'login', '/synthetic/zcode', f.config, f.backend, controller.signal, f),
    ).rejects.toThrow()
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })

  it.each(['grok', 'zcode'] as const)(
    '%s terminal files stay private under a permissive parent umask',
    async (cli) => {
      const f = fixture()
      const executable = join(f.home, cli === 'zcode' ? 'synthetic-cli.cjs' : 'synthetic-grok')
      writeFileSync(
        executable,
        `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const root = process.env.GROK_HOME ?? process.env.ZCODE_DATA_BASE_DIR; const dir = path.join(root, 'synthetic-output'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'credential.json'), 'SYNTHETIC');`,
      )
      chmodSync(executable, 0o755)
      const launch = await zcodeGrokAccountLaunch(cli, 'login', executable, f.config, f.backend, f.signal, f)
      // Only this disposable parent is given 022; the test runner/Host is untouched.
      const outcome = spawnSync(
        process.execPath,
        [
          '-e',
          'process.umask(0o022); const result = require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit", env: process.env }); process.exit(result.status ?? 1);',
          ...launch.argv,
        ],
        {
          cwd: launch.cwd,
          env: { ...process.env, ...launch.env },
          timeout: 10_000,
          encoding: 'utf8',
        },
      )
      expect(outcome.status, outcome.stderr).toBe(0)
      const root = launch.env.GROK_HOME ?? launch.env.ZCODE_DATA_BASE_DIR!
      expect(statSync(join(root, 'synthetic-output')).mode & 0o777).toBe(0o700)
      expect(statSync(join(root, 'synthetic-output/credential.json')).mode & 0o777).toBe(0o600)
    },
  )
})

// Native-shaped but entirely synthetic records. Never read or mutate a user's account.
it('decrypts ZCode 0.16.9 records and exposes only the user-info identity', () => {
  const secret = 'synthetic-cipher-secret'
  const key = createHash('sha256').update(secret).digest()
  const encrypt = (text: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(text), cipher.final()])
    return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
  }
  const raw = {
    'oauth:active_provider': encrypt('bigmodel'),
    'oauth:bigmodel:access_token': encrypt('SYNTHETIC-TOKEN'),
    'oauth:bigmodel:user_info': encrypt(
      JSON.stringify({
        displayName: 'Fixture',
        rawProfile: { email: 'fixture@example.invalid', token: 'SECRET' },
      }),
    ),
  }
  const status = projectZCodeIdentity(raw, secret)
  expect(status).toMatchObject({
    state: 'configured',
    authMethod: 'oauth',
    verification: 'local',
    accountLabel: 'fixture@example.invalid',
  })
  expect(JSON.stringify(status)).not.toMatch(/SECRET|TOKEN|enc:v1/)
  expect(() => projectZCodeIdentity(raw, 'wrong-key')).toThrow()
  expect(projectZCodeIdentity({ 'oauth:active_provider': 'bigmodel' }, secret).state).toBe('unauthenticated')
})
it('keeps Grok local sessions unverified and rejects expired access even with refresh credentials', () => {
  const session = {
    auth_mode: 'oidc',
    key: 'SECRET',
    refresh_token: 'SECRET_REFRESH',
    email: 'fixture@example.invalid',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }
  const raw = { 'https://auth.x.ai::synthetic-client': session }
  const status = projectGrokIdentity(raw)
  expect(status).toMatchObject({
    state: 'configured',
    accountLabel: 'fixture@example.invalid',
    verification: 'local',
  })
  expect(JSON.stringify(status)).not.toContain('SECRET')
  expect(
    projectGrokIdentity({
      'https://auth.x.ai::synthetic-client': { ...session, expires_at: '2020-01-01T00:00:00Z' },
    }).state,
  ).toBe('unauthenticated')
  expect(projectGrokIdentity({ unrelated: session }).state).toBe('unknown')
  expect(
    projectGrokIdentity({ 'https://auth.x.ai::synthetic-client': { ...session, email: 'Bearer SECRET' } })
      .accountLabel,
  ).toBeUndefined()
})

it('does not label refresh-only or expired ZCode OAuth as authenticated', () => {
  const raw = { 'oauth:active_provider': 'bigmodel', 'oauth:bigmodel:refresh_token': 'SYNTHETIC_REFRESH' }
  expect(projectZCodeIdentity(raw, 'synthetic-secret')).toMatchObject({
    state: 'configured',
    authMethod: 'oauth',
  })
  const expired = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.synthetic`
  expect(
    projectZCodeIdentity({ ...raw, 'oauth:bigmodel:access_token': expired }, 'synthetic-secret'),
  ).toMatchObject({ state: 'unauthenticated' })
  expect(
    projectGrokIdentity({
      'https://auth.x.ai::fixture': { auth_mode: 'oidc', refresh_token: 'SYNTHETIC_REFRESH' },
    }),
  ).toMatchObject({ state: 'configured' })
})
