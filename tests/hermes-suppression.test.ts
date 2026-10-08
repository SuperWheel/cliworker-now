import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hermesSourceSuppressed,
  hermesUnsuppressedEnvironment,
  projectHermesUnsuppressedAuth,
} from '../src/host/hermes-suppression.ts'
import { hermesAccountModels } from '../src/host/hermes-models.ts'
import { readCliAccountBinding } from '../src/host/cli-account-binding.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { NOUS_INFERENCE, NOUS_PORTAL } from '../src/host/hermes-nous.ts'
import { projectHermesIdentity, readHermesAccount } from '../src/host/hermes-accounts.ts'

// Synthetic native stores only; never launches a CLI or sends a network request.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn() }
function fixture(provider = 'openrouter') {
  const home = mkdtempSync(join(tmpdir(), 'hermes-suppression-synthetic-'))
  roots.push(home)
  writeFileSync(
    join(home, 'config.yaml'),
    JSON.stringify({
      auth: { adopt_external_logins: false },
      model: { provider, default: 'synthetic/model' },
    }),
  )
  const config = { ...DEFAULT_CONFIG, hermesHome: home, stateDirectory: join(home, 'plugin') }
  return {
    home,
    save: (auth: unknown) => writeFileSync(join(home, 'auth.json'), JSON.stringify(auth)),
    bind: () => readCliAccountBinding('hermes', backend, config, home, new AbortController().signal),
    status: () => readHermesAccount(config, new AbortController().signal),
  }
}

it.each([{ sources: ['config:primary'] }, { sources: { 'config:primary': false } }])(
  'honors native list and legacy dictionary suppression without matching another source',
  ({ sources }) => {
    const auth = { suppressed_sources: { custom: sources } }
    expect(hermesSourceSuppressed(auth, 'custom', 'config:primary')).toBe(true)
    expect(hermesSourceSuppressed(auth, 'custom', 'config:primary-other')).toBe(false)
    expect(hermesSourceSuppressed(auth, 'other', 'config:primary')).toBe(false)
    expect(hermesSourceSuppressed(auth, 'custom', 'manual')).toBe(false)
  },
)

it.each([null, [], 'unknown', { openrouter: null }, { openrouter: ['manual', 1] }])(
  'refuses malformed suppression rather than restoring a removed source (case %#)',
  (suppressed_sources) => {
    expect(() => projectHermesUnsuppressedAuth({ suppressed_sources })).toThrow('退出记录无法确认')
  },
)

it('projects exact config/env/singleton sources without changing raw data or unrelated credentials', () => {
  const auth = {
    providers: { nous: { agent_key: 'synthetic-nouse-key' }, 'xai-oauth': { tokens: {} } },
    credential_pool: {
      nous: [{ source: 'device_code' }, { source: 'manual:device_code' }],
      custom: [{ source: 'config:primary' }, { source: 'model_config' }, { source: 'manual' }],
    },
    suppressed_sources: { nous: ['device_code'], custom: ['config:primary', 'model_config'] },
  }
  const before = JSON.stringify(auth)
  const result = projectHermesUnsuppressedAuth(auth)
  expect(result.providers).toEqual({ 'xai-oauth': { tokens: {} } })
  expect(result.credential_pool).toEqual({
    nous: [{ source: 'manual:device_code' }],
    custom: [{ source: 'manual' }],
  })
  expect(JSON.stringify(auth)).toBe(before)
})

it('keeps environment suppression scoped to the exact provider and variable', () => {
  const auth = { suppressed_sources: { openrouter: ['env:OPENROUTER_API_KEY'] } }
  const env = { OPENROUTER_API_KEY: 'synthetic-one', OPENROUTER_API_KEY_2: 'synthetic-two' }
  expect(hermesUnsuppressedEnvironment(auth, env, 'openrouter')).toEqual({
    OPENROUTER_API_KEY_2: 'synthetic-two',
  })
  expect(hermesUnsuppressedEnvironment(auth, env, 'other')).toEqual(env)
})

it('does not rediscover or bind a suppressed key retained in its own environment', async () => {
  const f = fixture()
  writeFileSync(join(f.home, '.env'), 'OPENROUTER_API_KEY=synthetic-retained-key\n')
  f.save({
    credential_pool: { openrouter: [] },
    suppressed_sources: { openrouter: ['env:OPENROUTER_API_KEY'] },
  })
  const paths = ['auth.json', '.env', 'config.yaml'].map((name) => join(f.home, name))
  const before = paths.map((path) => readFileSync(path))
  const fetch = vi.fn()
  expect((await hermesAccountModels(f.home, 'openrouter', { fetch })).models).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  await expect(f.bind()).rejects.toThrow('无法确认当前自身账号')
  expect((await f.status()).state).toBe('unconfigured')
  expect(paths.map((path) => readFileSync(path))).toEqual(before)
})

it('retains an independent manual key and changes its binding after another source is removed', async () => {
  const f = fixture()
  writeFileSync(join(f.home, '.env'), 'OPENROUTER_API_KEY=synthetic-env-key\n')
  const auth: any = {
    credential_pool: {
      openrouter: [{ source: 'manual', auth_type: 'api_key', access_token: 'synthetic-manual-key' }],
    },
  }
  f.save(auth)
  const before = await f.bind()
  auth.suppressed_sources = { openrouter: ['env:OPENROUTER_API_KEY'] }
  f.save(auth)
  expect(await f.bind()).not.toBe(before)
  expect(await f.status()).toMatchObject({ state: 'authenticated', authMethod: 'api' })
  const fetch = vi.fn(async (_url, init) => {
    expect(init.headers.Authorization).toBe('Bearer synthetic-manual-key')
    return new Response(JSON.stringify({ data: [{ id: 'synthetic/model' }] }))
  })
  expect((await hermesAccountModels(f.home, 'openrouter', { fetch })).models).toHaveLength(1)
  expect(fetch).toHaveBeenCalledOnce()
})

it('ignores a suppressed OAuth singleton retained in the native file without refreshing it', async () => {
  const f = fixture('nous')
  const key = `e30.${Buffer.from(JSON.stringify({ sub: 'synthetic-user', org_id: 'synthetic-org', iss: NOUS_PORTAL, exp: 4e9, scope: 'inference:invoke' })).toString('base64url')}.synthetic`
  const state = {
    access_token: key,
    agent_key: key,
    scope: 'inference:invoke',
    portal_base_url: NOUS_PORTAL,
    inference_base_url: NOUS_INFERENCE,
  }
  f.save({
    active_provider: 'nous',
    providers: { nous: state },
    credential_pool: { nous: [{ ...state, source: 'device_code', auth_type: 'oauth' }] },
    suppressed_sources: { nous: ['device_code'] },
  })
  const fetch = vi.fn()
  await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.toThrow()
  await expect(f.bind()).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  expect((await f.status()).state).toBe('unconfigured')
})

it('keeps removed config credentials unavailable even when the native config value remains', async () => {
  const f = fixture('custom')
  const rawConfig = JSON.stringify({
    auth: { adopt_external_logins: false },
    model: {
      provider: 'custom',
      default: 'synthetic/model',
      api_key: 'synthetic-retained-config-key',
      base_url: 'https://synthetic.invalid/v1',
    },
  })
  writeFileSync(join(f.home, 'config.yaml'), rawConfig)
  f.save({ credential_pool: { custom: [] }, suppressed_sources: { custom: ['model_config'] } })
  const fetch = vi.fn()
  expect((await hermesAccountModels(f.home, 'custom', { fetch })).models).toEqual([])
  await expect(f.bind()).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  expect(readFileSync(join(f.home, 'config.yaml'), 'utf8')).toBe(rawConfig)
})

it('does not display a removed config pool key or restore a cached previous login', async () => {
  const f = fixture()
  const auth: any = {
    credential_pool: {
      openrouter: [{ source: 'config', auth_type: 'api_key', access_token: 'synthetic-config-key' }],
    },
  }
  f.save(auth)
  expect((await f.status()).state).toBe('authenticated')
  auth.suppressed_sources = { openrouter: ['config'] }
  f.save(auth)
  expect((await f.status()).state).toBe('unconfigured')
  expect(projectHermesIdentity(auth)).toBeUndefined()
})

it('fails account projection safely on malformed suppression metadata', async () => {
  const f = fixture()
  f.save({ suppressed_sources: 'synthetic-invalid' })
  expect((await f.status()).state).toBe('unavailable')
})
