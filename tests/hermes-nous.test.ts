import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermesAccountModels, assertHermesOwnAccounts } from '../src/host/hermes-models.ts'
import { discoverHermes, prepareHermes } from '../src/host/hermes-adapter.ts'
import { projectHermesIdentity, readHermesAccount } from '../src/host/hermes-accounts.ts'
import {
  hermesNousEfforts,
  fetchHermesNousModels,
  hermesNousMinimumTtl,
  selectHermesNousSource,
  NOUS_INFERENCE,
  NOUS_PORTAL,
} from '../src/host/hermes-nous.ts'
import { readCliAccountBinding } from '../src/host/cli-account-binding.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'

// Explicit synthetic fixtures. HTTP is mocked and no native executable is run.
const roots: string[] = []
const jwt = (extra: Record<string, unknown> = {}) =>
  `e30.${Buffer.from(
    JSON.stringify({
      sub: 'synthetic-user',
      org_id: 'synthetic-org',
      iss: NOUS_PORTAL,
      client_id: 'synthetic-client',
      scope: 'inference:invoke',
      exp: 4e9,
      paid_access: false,
      ...extra,
    }),
  ).toString('base64url')}.synthetic`
function auth(extra: Record<string, unknown> = {}) {
  const token = jwt(extra)
  const state = {
    access_token: token,
    agent_key: token,
    refresh_token: 'synthetic-refresh',
    scope: 'inference:invoke',
    portal_base_url: NOUS_PORTAL,
    inference_base_url: NOUS_INFERENCE,
  }
  return {
    active_provider: 'nous',
    providers: { nous: state },
    credential_pool: { nous: [{ ...state, source: 'device_code', auth_type: 'oauth' }] },
  } as any
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-nous-synthetic-'))
  roots.push(home)
  const config = {
    auth: { adopt_external_logins: false },
    model: { provider: 'nous', default: 'synthetic/free', base_url: NOUS_INFERENCE },
  }
  writeFileSync(join(home, 'config.yaml'), JSON.stringify(config))
  const raw = auth()
  const executable = join(home, 'synthetic-hermes')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(join(home, 'auth.json'), JSON.stringify(raw))
  return {
    home,
    executable,
    raw,
    config,
    save: () => writeFileSync(join(home, 'auth.json'), JSON.stringify(raw)),
  }
}
const signal = () => new AbortController().signal
const account = (paid = false) => ({
  organisation: { id: 'synthetic-org' },
  user: { privy_did: 'synthetic-user' },
  paid_service_access: { allowed: paid },
})
const free = (id = 'synthetic/free') => ({
  id,
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['tools', 'reasoning'],
  reasoning: { supported_efforts: ['low', 'high'] },
})
function http(rows: any[] = [free()], paid = false) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    expect([`${NOUS_PORTAL}/api/oauth/account`, `${NOUS_INFERENCE}/models`]).toContain(url)
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${jwt()}` })
    return new Response(JSON.stringify(String(url).endsWith('/models') ? { data: rows } : account(paid)))
  })
}
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('Hermes own Nous OAuth identity, binding and native account models', () => {
  it('recognizes the flat native OAuth schema without requiring email and never exposes bearer or principal', async () => {
    const f = fixture()
    const result = await readHermesAccount(
      { ...DEFAULT_CONFIG, stateDirectory: join(f.home, 'state'), hermesHome: f.home },
      signal(),
    )
    expect(result).toMatchObject({
      state: 'authenticated',
      verification: 'local',
      logins: [{ providerLabel: 'Nous', authMethod: 'oauth' }],
    })
    expect(result.accountLabel).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/synthetic|agent_key|refresh_token/)
    const withEmail = projectHermesIdentity(auth({ email: 'fixture@example.test' }))
    expect(withEmail?.accountLabel).toBe('fixture@example.test')
  })
  it.each([
    'guest',
    'expired',
    'wrong-scope',
    'missing-agent',
    'mismatched-pool',
    'external-source',
    'dead',
    'revoked',
  ])('does not promote %s native credentials', (kind) => {
    const raw =
      kind === 'expired' ? auth({ exp: 1 }) : kind === 'wrong-scope' ? auth({ scope: 'profile' }) : auth()
    if (kind === 'guest') raw.providers.nous.auth_method = 'anonymous'
    if (kind === 'wrong-scope') raw.providers.nous.scope = 'profile'
    if (kind === 'missing-agent') delete raw.providers.nous.agent_key
    if (kind === 'mismatched-pool') raw.credential_pool.nous[0].agent_key = jwt({ sub: 'other' })
    if (kind === 'external-source') raw.credential_pool.nous[0].source = 'manual:codex_cli'
    if (kind === 'dead') raw.credential_pool.nous[0].last_status = 'dead'
    if (kind === 'revoked') raw.providers.nous.last_auth_error = { relogin_required: true }
    expect(projectHermesIdentity(raw)?.state).not.toBe('authenticated')
  })
  it('keeps account login independent of model TTL and model configuration errors', async () => {
    const f = fixture(),
      raw = auth({ exp: Date.now() / 1000 + 90 })
    writeFileSync(join(f.home, 'auth.json'), JSON.stringify(raw))
    expect(projectHermesIdentity(raw)?.state).toBe('authenticated')
    await expect(hermesAccountModels(f.home, 'nous', { fetch: http() })).rejects.toThrow('即将过期')
    writeFileSync(join(f.home, 'config.yaml'), 'invalid: [')
    expect(
      (
        await readHermesAccount(
          { ...DEFAULT_CONFIG, hermesHome: f.home, stateDirectory: join(f.home, 'state') },
          signal(),
        )
      ).state,
    ).toBe('authenticated')
  })
  it('reuses a valid token below native proactive-refresh default with the supported child-only override', async () => {
    const f = fixture(),
      raw = auth({ exp: Date.now() / 1000 + 600 })
    writeFileSync(join(f.home, 'auth.json'), JSON.stringify(raw))
    expect(selectHermesNousSource(await assertHermesOwnAccounts(f.home)).agentKey).toBe(
      raw.providers.nous.agent_key,
    )
    const launch = await prepareHermes({
      executable: f.executable,
      project: f.home,
      preference: { model: '["nous","synthetic/free"]', effort: 'default' },
      mode: 'accept-edits',
      prompt: 'synthetic',
      stateDirectory: join(f.home, 'worker'),
      hermesHome: f.home,
    })
    expect(launch.env.HERMES_NOUS_MIN_KEY_TTL_SECONDS).toBe('120')
    writeFileSync(join(f.home, '.env'), 'HERMES_NOUS_MIN_KEY_TTL_SECONDS=1800')
    expect(() =>
      selectHermesNousSource({
        config: f.config,
        auth: raw,
        env: { HERMES_NOUS_MIN_KEY_TTL_SECONDS: '1800' },
      }),
    ).toThrow('即将过期')
    writeFileSync(join(f.home, 'auth.json'), JSON.stringify(auth()))
    const explicit = await prepareHermes({
      executable: f.executable,
      project: f.home,
      preference: { model: '["nous","synthetic/free"]', effort: 'default' },
      mode: 'accept-edits',
      prompt: 'synthetic',
      stateDirectory: join(f.home, 'worker'),
      hermesHome: f.home,
    })
    expect(explicit.env.HERMES_NOUS_MIN_KEY_TTL_SECONDS).toBe('1800')
  })
  it('rejects a token that crosses its usable TTL threshold during metadata reads', async () => {
    const f = fixture(),
      now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    writeFileSync(join(f.home, 'auth.json'), JSON.stringify(auth({ exp: now / 1000 + 300 })))
    const fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/models')) {
        clock.mockReturnValue(now + 200000)
        return new Response(JSON.stringify({ data: [free()] }))
      }
      return new Response(JSON.stringify(account()))
    })
    await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.toThrow('即将过期')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each(['60', '90'])(
    'normalizes own TTL %s to the native invoke-JWT floor in every launch',
    async (value) => {
      const f = fixture()
      writeFileSync(join(f.home, '.env'), `HERMES_NOUS_MIN_KEY_TTL_SECONDS=${value}`)
      expect(hermesNousMinimumTtl({ HERMES_NOUS_MIN_KEY_TTL_SECONDS: value })).toBe(120)
      const launch = await prepareHermes({
        executable: f.executable,
        project: f.home,
        preference: { model: '["nous","synthetic/free"]', effort: 'default' },
        mode: 'accept-edits',
        prompt: 'synthetic',
        stateDirectory: join(f.home, 'worker'),
        hermesHome: f.home,
      })
      expect(launch.env.HERMES_NOUS_MIN_KEY_TTL_SECONDS).toBe('120')
      const material = await assertHermesOwnAccounts(f.home)
      material.auth = auth({ exp: Date.now() / 1000 + 100 })
      expect(() => selectHermesNousSource(material)).toThrow('即将过期')
    },
  )
  it('preserves login display but refuses a singleton whose native pool needs initialization', async () => {
    const f = fixture()
    delete f.raw.credential_pool
    f.save()
    expect(projectHermesIdentity(f.raw)?.state).toBe('authenticated')
    const fetch = http()
    await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.toThrow('完成原生账号初始化')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['route', 'env-route', 'env-key', 'model-key', 'portal-alias'])(
    'refuses an alternate runtime %s before HTTP',
    async (kind) => {
      const f = fixture()
      if (kind === 'route') f.config.model.base_url = 'https://synthetic.invalid/v1'
      if (kind === 'model-key') (f.config.model as any).api_key = 'synthetic-other-key'
      writeFileSync(join(f.home, 'config.yaml'), JSON.stringify(f.config))
      if (kind === 'env-route')
        writeFileSync(join(f.home, '.env'), 'NOUS_INFERENCE_BASE_URL=https://synthetic.invalid/v1')
      if (kind === 'env-key') writeFileSync(join(f.home, '.env'), 'NOUS_API_KEY=synthetic-other-key')
      if (kind === 'portal-alias')
        writeFileSync(join(f.home, '.env'), 'HERMES_PORTAL_BASE_URL=https://synthetic.invalid')
      const fetch = http()
      await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.toThrow(/路由|额外认证/)
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('binds stable native principal/organization/source while allowing ordinary token renewal', async () => {
    const f = fixture(),
      backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn() }
    const cfg = { ...DEFAULT_CONFIG, stateDirectory: join(f.home, 'state'), hermesHome: f.home }
    const run = () => readCliAccountBinding('hermes', backend, cfg, f.home, signal())
    const before = await run()
    writeFileSync(join(f.home, 'auth.json'), JSON.stringify(auth({ jti: 'renewed', exp: 4e9 + 60 })))
    expect(await run()).toBe(before)
    writeFileSync(join(f.home, 'auth.json'), JSON.stringify(auth({ org_id: 'other-org' })))
    expect(await run()).not.toBe(before)
    rmSync(join(f.home, 'auth.json'))
    await expect(run()).rejects.toThrow('账号')
    expect(backend.spawn).not.toHaveBeenCalled()
  })
  it('uses only the same account bearer for two GETs and filters paid, unknown and native incompatible rows', async () => {
    const f = fixture(),
      rows = [
        free(),
        { ...free('synthetic/paid'), pricing: { prompt: '1', completion: '1' } },
        { ...free('synthetic/extra-charge'), pricing: { prompt: '0', completion: '0', request: '0.01' } },
        { ...free('synthetic/unknown'), pricing: { prompt: '0' } },
        { ...free('synthetic/tools-no'), supported_parameters: ['temperature'] },
        free('synthetic/video-gen'),
        free('nous/hermes-3'),
        { ...free('synthetic/image-model'), architecture: { output_modalities: ['image'] } },
        { ...free('synthetic/denied'), allowed: false },
        {
          ...free('synthetic/sale'),
          pricing: { prompt: 0, completion: 0, original: { prompt: 1, completion: 1 } },
        },
      ]
    const fetch = http(rows),
      scope = await hermesAccountModels(f.home, 'nous', { fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(scope.models).toEqual([
      { id: 'synthetic/free', cost: 'free' },
      { id: 'synthetic/sale', cost: 'free' },
    ])
    expect(JSON.stringify(scope)).not.toMatch(/synthetic-user|synthetic-org|agent_key/)
    expect(
      hermesNousEfforts(
        f.home,
        selectHermesNousSource(await assertHermesOwnAccounts(f.home)),
        'synthetic/free',
      ),
    ).toEqual(['default', 'low', 'high'])
  })
  it('supports native tools metadata absence and limits explicit efforts to shared native values', async () => {
    const f = fixture(),
      row: any = free()
    delete row.supported_parameters
    expect((await hermesAccountModels(f.home, 'nous', { fetch: http([row]) })).models).toHaveLength(1)
    const source = selectHermesNousSource(await assertHermesOwnAccounts(f.home))
    expect(hermesNousEfforts(f.home, source, row.id)).toEqual(['default'])
    row.supported_parameters = ['tools', 'reasoning']
    row.reasoning.supported_efforts = ['high', 'unknown', 'ultra', 'high']
    await hermesAccountModels(f.home, 'nous', { fetch: http([row]) })
    expect(hermesNousEfforts(f.home, source, row.id)).toEqual(['default', 'high'])
  })
  it.each(['organisation', 'subject', 'permission-schema'])(
    'rejects mismatched %s account response without listing models',
    async (kind) => {
      const f = fixture(),
        payload: any = account()
      if (kind === 'organisation') payload.organisation.id = 'other'
      if (kind === 'subject') payload.user.privy_did = 'other'
      if (kind === 'permission-schema') payload.paid_service_access.allowed = 'false'
      const fetch = vi.fn(async () => new Response(JSON.stringify(payload)))
      await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.toThrow('账号权限格式')
      expect(fetch).toHaveBeenCalledOnce()
    },
  )
  it.each(['logout', 'switch', 'rotation', 'cooldown'])(
    'rejects %s while account metadata is in flight',
    async (kind) => {
      const f = fixture(),
        base = http()
      const fetch: typeof globalThis.fetch = async (url, init) => {
        const response = await base(url, init)
        if (String(url).endsWith('/models')) {
          if (kind === 'logout') rmSync(join(f.home, 'auth.json'))
          if (kind === 'switch' || kind === 'rotation')
            writeFileSync(
              join(f.home, 'auth.json'),
              JSON.stringify(auth(kind === 'switch' ? { sub: 'other' } : { jti: 'renewed' })),
            )
          if (kind === 'cooldown') {
            f.raw.credential_pool.nous[0].model_cooldowns = { 'synthetic/free': 4e9 }
            f.save()
          }
        }
        return response
      }
      await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.toThrow('账号')
    },
  )
  it.each([401, 403, 302, 500])('does not retry or follow an HTTP %i response', async (status) => {
    const f = fixture(),
      fetch = vi.fn(async () => new Response('synthetic-private-server-error', { status }))
    await expect(hermesAccountModels(f.home, 'nous', { fetch })).rejects.not.toThrow('synthetic-private')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('sanitizes malformed and oversized responses', async () => {
    const f = fixture()
    for (const body of ['private-invalid-json', 'x'.repeat(1024 * 1024 + 1)]) {
      await expect(
        hermesAccountModels(f.home, 'nous', { fetch: vi.fn(async () => new Response(body)) }),
      ).rejects.toThrow('元数据无法读取')
    }
  })
  it('cancels a hanging body and removes old capabilities after a failed query', async () => {
    const f = fixture(),
      source = selectHermesNousSource(await assertHermesOwnAccounts(f.home))
    await hermesAccountModels(f.home, 'nous', { fetch: http() })
    const abort = new AbortController(),
      cancel = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              setTimeout(() => abort.abort(new Error('cancelled')), 1)
            },
            cancel,
          }),
        ),
    )
    await expect(hermesAccountModels(f.home, 'nous', { fetch, signal: abort.signal })).rejects.toThrow(
      'cancelled',
    )
    expect(cancel).toHaveBeenCalled()
    expect(hermesNousEfforts(f.home, source, 'synthetic/free')).toEqual(['default'])
  })
  it('keeps capability evidence independent across two own homes', async () => {
    const a = fixture(),
      b = fixture()
    await Promise.all([a, b].map((f) => hermesAccountModels(f.home, 'nous', { fetch: http() })))
    for (const f of [a, b])
      expect(
        hermesNousEfforts(
          f.home,
          selectHermesNousSource(await assertHermesOwnAccounts(f.home)),
          'synthetic/free',
        ),
      ).toEqual(['default', 'low', 'high'])
  })
  it('a cancelled concurrent request cannot erase the later successful query capabilities', async () => {
    const f = fixture(),
      abort = new AbortController()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start() {
            entered()
          },
        }),
      )
    const first = hermesAccountModels(f.home, 'nous', { fetch, signal: abort.signal })
    const rejected = expect(first).rejects.toThrow('cancelled')
    await started
    await hermesAccountModels(f.home, 'nous', { fetch: http() })
    abort.abort(new Error('cancelled'))
    await rejected
    const source = selectHermesNousSource(await assertHermesOwnAccounts(f.home))
    expect(hermesNousEfforts(f.home, source, 'synthetic/free')).toEqual(['default', 'low', 'high'])
  })
  it('bounds a stalled body by the metadata deadline without refreshing or retrying', async () => {
    const f = fixture(),
      source = selectHermesNousSource(await assertHermesOwnAccounts(f.home)),
      cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })))
    await expect(fetchHermesNousModels(f.home, source, { fetch, timeoutMs: 5 })).rejects.toThrow('超时')
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalled()
  })
  it('discovers Nous without native config commands and rejects a changed source before launch', async () => {
    const f = fixture(),
      capture = vi.fn(),
      state = join(f.home, 'worker')
    const result = await discoverHermes(f.executable, capture, state, f.home, { fetch: http() })
    expect(capture).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({
      id: '["nous","synthetic/free"]',
      efforts: ['default', 'low', 'high'],
      cost: 'free',
    })
    f.raw.credential_pool.nous[0].agent_key = jwt({ sub: 'other' })
    f.save()
    await expect(
      prepareHermes({
        executable: f.executable,
        project: f.home,
        preference: { model: result[0]!.id, effort: 'high' },
        mode: 'accept-edits',
        prompt: 'synthetic',
        stateDirectory: state,
        hermesHome: f.home,
      }),
    ).rejects.toThrow('账号')
  })
})
