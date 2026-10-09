import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localAccountIdentity } from '../src/host/account-identity.ts'
import { readCodexOwnAccountSource } from '../src/host/cli-account-binding.ts'
import { readKimiAccount } from '../src/host/kimi-accounts.ts'
import { mimoConfigurationPaths, readMimoAccount } from '../src/host/mimo-configuration.ts'
import { prepareMimoAccountTerminal } from '../src/host/first-party-account-context.ts'
import { claudeManagedSettingsPath, readFirstPartyModelSources } from '../src/host/first-party-models.ts'
import { nativeAccountAncestors, inspectPiOmpNativeAccount } from '../src/host/pi-omp-native.ts'
import { readHermesAccount } from '../src/host/hermes-accounts.ts'
import { inspectOpenCodeProfile } from '../src/host/opencode-native.ts'
import { zcodeGrokAccountStatus } from '../src/host/zcode-grok-accounts.ts'
import { DEFAULT_CONFIG, type RuntimeConfig } from '../src/host/process.ts'
import { CLI_IDS, type CliId } from '../src/shared/types.ts'

// Real platform filesystem, synthetic accounts only. No CLI, network, model
// generation, symlink privilege, or POSIX permission-bit assertion is required.
let root: string, project: string, config: RuntimeConfig
const signal = () => new AbortController().signal
const jwt = (sub: string, extra: Record<string, unknown> = {}) =>
  `e30.${Buffer.from(JSON.stringify({ sub, ...extra })).toString('base64url')}.synthetic`
const kimiProviders = JSON.stringify({
  providers: { 'managed:kimi-code': { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } } },
})
const write = async (path: string, value: unknown, raw = false) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, raw ? String(value) : JSON.stringify(value), { mode: 0o600 })
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cwn-windows-accounts-synthetic-')))
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('DSH_HOME', join(root, '.dsh'))
  // Match the actual native XDG/default-home APIs; fail before a read if the
  // operating system did not accept the isolated home environment.
  expect(await realpath(homedir())).toBe(root)
  for (const key of Object.keys(process.env))
    if (/ANTHROPIC|CLAUDE_CODE_(?:OAUTH|USE_|API)|AWS_|GOOGLE_|CLOUD_ML|API_KEY|BEARER_TOKEN/.test(key))
      vi.stubEnv(key, '')
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'XAI_API_KEY',
    'GEMINI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_BASE_URL',
    'CHATGPT_BASE_URL',
    'CODEX_PROFILE',
    'GROK_HOME',
    'GROK_AUTH_PATH',
    'GROK_CONFIG_PATH',
    'GROK_AUTH_PROVIDER_COMMAND',
    'GROK_OIDC_ISSUER',
    'GROK_OIDC_CLIENT_ID',
    'GROK_CLI_CHAT_PROXY_BASE_URL',
    'GROK_MODELS_BASE_URL',
    'GROK_MODELS_LIST_URL',
    'GROK_XAI_API_BASE_URL',
    'GROK_DEPLOYMENT_KEY',
    'OPENCODE_MODELS_PATH',
    'OPENCODE_AUTH',
    'MIMOCODE_AUTH_CONTENT',
    'PI_CODING_AGENT_DIR',
    'PI_CONFIG_DIR',
    'OMP_AUTH_BROKER_URL',
    'OMP_AUTH_BROKER_TOKEN',
  ])
    vi.stubEnv(key, '')
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'))
  vi.stubEnv('KIMI_CODE_HOME', join(root, '.kimi-code'))
  vi.stubEnv('MIMOCODE_HOME', join(root, '.mimocode-native'))
  vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  vi.stubEnv('XDG_CONFIG_HOME', join(root, '.config'))
  vi.stubEnv('XDG_DATA_HOME', join(root, '.local/share'))
  project = join(root, 'project')
  await mkdir(project)
  config = {
    ...DEFAULT_CONFIG,
    stateDirectory: join(root, 'plugin'),
    hermesHome: join(root, '.hermes'),
    zcodeAuthDirectory: join(root, 'zcode'),
    zcodeBuiltinConfig: join(root, 'zcode-builtin.json'),
  }
  await write(config.zcodeBuiltinConfig!, {})
  await mkdir(config.hermesHome!, { recursive: true })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function configured(cli: CliId): Promise<boolean> {
  if (cli === 'antigravity')
    return (await localAccountIdentity({ home: root })(cli, signal()))?.state === 'authenticated'
  if (cli === 'codex') {
    try {
      return !!(await readCodexOwnAccountSource(project, signal())).credential
    } catch {
      return false
    }
  }
  if (cli === 'claude')
    return (
      (
        await readFirstPartyModelSources(
          'claude',
          '/synthetic/claude.exe',
          project,
          async (argv) =>
            argv.includes('--help')
              ? '--model --output-format'
              : JSON.stringify({ loggedIn: true, authMethod: 'api_key' }),
          signal(),
        )
      ).length > 0
    )
  if (cli === 'kimi')
    return (
      (await readKimiAccount(kimiProviders, signal(), { home: join(root, '.kimi-code') })).state ===
      'authenticated'
    )
  if (cli === 'mimo') return (await readMimoAccount(signal())).state === 'authenticated'
  if (cli === 'pi' || cli === 'omp')
    return (
      (await inspectPiOmpNativeAccount(cli, config.stateDirectory!, signal(), { nativeHome: root })).state ===
      'authenticated'
    )
  if (cli === 'hermes') return (await readHermesAccount(config, signal())).state === 'authenticated'
  if (cli === 'opencode')
    return (
      (
        await inspectOpenCodeProfile(join(root, 'opencode-plugin/data'), {
          nativeHome: root,
          signal: signal(),
        })
      ).state === 'authenticated'
    )
  if (cli === 'zcode' || cli === 'grok')
    return (
      (
        await zcodeGrokAccountStatus(cli, config, signal(), {
          home: root,
          credentialSecret: 'synthetic-secret',
        })
      ).state === 'authenticated'
    )
  throw new Error('Unexpected retired CLI in Windows account test')
}

async function ownAccount(cli: CliId, identity = 'own'): Promise<string> {
  const key = `synthetic-${cli}-${identity}`
  let path: string
  if (cli === 'antigravity') {
    path = join(root, '.gemini/jetski-standalone-oauth-token')
    await write(path, {
      auth_method: 'consumer',
      token: { access_token: key, refresh_token: 'synthetic-refresh', expiry: '2099-01-01T00:00:00Z' },
      id_token: jwt(identity, { email: `${identity}@example.invalid` }),
    })
  } else if (cli === 'codex') {
    path = join(root, '.codex/auth.json')
    await write(path, { auth_mode: 'apikey', OPENAI_API_KEY: key })
  } else if (cli === 'claude') {
    path = join(root, '.claude/settings.json')
    await write(path, { env: { ANTHROPIC_API_KEY: key } })
  } else if (cli === 'kimi') {
    path = join(root, '.kimi-code/credentials/kimi-code.json')
    await write(path, {
      access_token: jwt(`account-${identity}`, { iss: 'kimi-auth' }),
      refresh_token: 'synthetic-refresh',
      expires_at: 4e9,
    })
  } else if (cli === 'mimo') {
    path = join(root, '.mimocode-native/data/auth.json')
    await write(path, { xiaomi: { type: 'api', key } })
  } else if (cli === 'pi') {
    path = join(root, '.pi/agent/auth.json')
    await write(path, { own: { type: 'api_key', key } })
  } else if (cli === 'omp') {
    path = join(root, '.omp/agent/agent.db')
    await mkdir(dirname(path), { recursive: true })
    await rm(path, { force: true })
    const db = new DatabaseSync(path)
    try {
      db.exec(
        'CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)',
      )
      db.prepare('INSERT INTO auth_credentials VALUES (?,?,?,?)').run(
        'own',
        'api_key',
        JSON.stringify({ key }),
        null,
      )
    } finally {
      db.close()
    }
  } else if (cli === 'hermes') {
    path = join(root, '.hermes/.env')
    await write(path, `OPENAI_API_KEY=${key}\n`, true)
  } else if (cli === 'opencode') {
    path = join(root, '.local/share/opencode/auth.json')
    await write(path, { own: { type: 'api', key } })
  } else if (cli === 'grok') {
    path = join(root, '.grok/auth.json')
    await write(path, {
      'https://auth.x.ai::synthetic-client': {
        auth_mode: 'oidc',
        oidc_issuer: 'https://auth.x.ai',
        oidc_client_id: 'synthetic-client',
        user_id: identity,
        key,
        expires_at: '2099-01-01T00:00:00Z',
        email: `${identity}@example.invalid`,
      },
    })
  } else if (cli === 'zcode') {
    path = join(root, 'zcode/.zcode/v2/credentials.json')
    const provider = 'account:bigmodel-individual-coding-plan'
    await write(path, {
      'oauth:active_provider': 'bigmodel',
      'oauth:bigmodel:user_info': JSON.stringify({ id: identity, email: `${identity}@example.invalid` }),
      [`account-provider:${provider}:identity`]: identity,
      [`account-provider:coding-plan:${provider}:account:${identity}:api-key`]: key,
    })
  } else throw new Error('Unexpected retired CLI in Windows account fixture')
  return path
}

describe('Windows account source contract on the real platform filesystem (synthetic only)', () => {
  it.each(CLI_IDS)(
    '%s does not infer login from Harness, another CLI, or ambient provider keys',
    async (cli) => {
      await write(join(root, '.dsh/credentials.json'), { key: 'synthetic-host-key' })
      await ownAccount(cli === 'codex' ? 'mimo' : 'codex', 'foreign')
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key')
      vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-ambient-key')
      vi.stubEnv('XAI_API_KEY', 'synthetic-ambient-key')
      expect(await configured(cli)).toBe(false)
    },
  )

  it.each(CLI_IDS)('%s reads its own live source and clears login after native logout', async (cli) => {
    expect(await configured(cli)).toBe(false)
    const path = await ownAccount(cli)
    const before = await readFile(path)
    expect(await configured(cli)).toBe(true)
    expect(await readFile(path)).toEqual(before)
    await ownAccount(cli, 'switched')
    expect(await configured(cli)).toBe(true)
    await rm(path)
    expect(await configured(cli)).toBe(false)
  })

  it('MiMo Windows native path stays live through logout and external switch; cleanup never restores a copy', async () => {
    const path = await ownAccount('mimo')
    const prepared = await prepareMimoAccountTerminal(
      '/synthetic/mimo.exe',
      'login',
      config.stateDirectory!,
      signal(),
      { platform: 'win32' },
    )
    expect(mimoConfigurationPaths({ env: prepared.env, osHome: root }).data).toBe(dirname(path))
    const runtime = dirname(prepared.cwd)
    expect(await readdir(join(runtime, 'data'))).toEqual([])
    expect(prepared.env.MIMOCODE_DB).toBe(join(runtime, 'data/mimocode.db'))
    await write(path, {})
    expect(await configured('mimo')).toBe(false)
    await rename(path, join(dirname(path), 'retired-auth.json'))
    await ownAccount('mimo', 'switched')
    const switched = await readFile(path)
    await prepared.cleanup()
    expect(await readFile(path)).toEqual(switched)
    expect(await configured('mimo')).toBe(true)
  })

  it('rejects a current source replaced during a bounded read and keeps the replacement (synthetic files)', async () => {
    const path = await ownAccount('mimo')
    const descriptor = await open(path, 'r')
    const prototype = Object.getPrototypeOf(descriptor)
    const originalRead = prototype.read
    await descriptor.close()
    let switched = false
    const read = vi.spyOn(prototype, 'read').mockImplementation(async function (this: unknown, ...args) {
      const result = await originalRead.apply(this, args)
      if (!switched) {
        switched = true
        await rename(path, join(dirname(path), 'retired-during-read.json'))
        await ownAccount('mimo', 'switched')
      }
      return result
    })
    try {
      await expect(readMimoAccount(signal())).rejects.toThrow('MiMo 配置来源无法确认')
    } finally {
      read.mockRestore()
    }
    expect(JSON.parse(await readFile(path, 'utf8')).xiaomi.key).toBe('synthetic-mimo-switched')
    expect(await configured('mimo')).toBe(true)
  })

  it('uses current Windows managed paths and preserves drive/UNC account roots', () => {
    expect(claudeManagedSettingsPath('win32', { ProgramFiles: 'D:\\Program Files' })).toBe(
      'D:\\Program Files\\ClaudeCode\\managed-settings.json',
    )
    expect(nativeAccountAncestors('C:\\Users\\名字\\.pi\\agent', win32).at(-1)).toBe(
      'C:\\Users\\名字\\.pi\\agent',
    )
    expect(nativeAccountAncestors('\\\\server\\share\\名字\\.kimi-code', win32)).toEqual([
      '\\\\server\\share\\名字',
      '\\\\server\\share\\名字\\.kimi-code',
    ])
  })
})
