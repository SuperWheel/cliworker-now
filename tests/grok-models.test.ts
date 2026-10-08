import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverGrokAccountModels,
  GROK_MODELS_URL,
  GROK_SETTINGS_URL,
  grokAccountModelIds,
  readGrokOwnAccount,
  selectGrokOwnAccount,
} from '../src/host/grok-models.ts'
import { discoverGrok } from '../src/host/grok-adapter.ts'
import type { ModelChoice } from '../src/shared/types.ts'
const roots: string[] = []
const allowed =
  (request: typeof fetch): typeof fetch =>
  async (url, init) =>
    url === GROK_SETTINGS_URL ? Response.json({ allow_access: true }) : request(url, init)
const session = () => ({
  auth_mode: 'oidc',
  oidc_issuer: 'https://auth.x.ai',
  oidc_client_id: 'synthetic-client',
  user_id: 'synthetic-user',
  key: 'SYNTHETIC_ACCESS',
  refresh_token: 'SYNTHETIC_REFRESH',
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  email: 'fixture@example.invalid',
})
function fixture(value = session()) {
  const home = mkdtempSync(join(tmpdir(), 'grok-models-synthetic-'))
  roots.push(home)
  mkdirSync(join(home, '.grok'))
  const path = join(home, '.grok/auth.json')
  const write = (auth: unknown) =>
    writeFileSync(path, JSON.stringify({ 'https://auth.x.ai::synthetic-client': auth }), { mode: 0o600 })
  write(value)
  return { home, path, write }
}
const native: ModelChoice[] = [
  { id: 'grok-a', label: 'Synthetic A', efforts: ['low', 'high'] },
  { id: 'grok-b', label: 'Synthetic B', efforts: ['default'] },
]
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('Grok own Build models (synthetic metadata only)', () => {
  it('requests only the official read-only endpoint and intersects exact IDs with native effort', async () => {
    const f = fixture()
    const request = vi.fn(async (url, init) => {
      expect(url).toBe(GROK_MODELS_URL)
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer SYNTHETIC_ACCESS',
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'x-userid': 'synthetic-user',
          'x-grok-client-version': '1.0.0',
          'x-grok-client-mode': 'headless',
        },
      })
      expect(init).not.toHaveProperty('body')
      return Response.json({
        data: [{ model: 'grok-a', supported_in_api: false }, { id: 'grok-remote-only' }],
      })
    })
    expect(await discoverGrokAccountModels(native, { home: f.home, fetch: allowed(request) })).toEqual([
      native[0],
    ])
    expect(request).toHaveBeenCalledOnce()
  })
  it('uses native offline capabilities before the own-account GET, never fallback as entitlement', async () => {
    const f = fixture(),
      calls: string[] = []
    const models = await discoverGrok(
      '/synthetic/grok',
      async (argv, env, phase) => {
        if (argv.includes('--version')) return 'grok 1.0.0 (3cd0d0cbcebe)'
        calls.push('native')
        expect(phase).toBe('native-candidates')
        expect(env?.GROK_AUTH_PATH).toContain('/catalog/home/auth.json')
        expect(env?.XAI_API_KEY).toBe('')
        return JSON.stringify(native)
      },
      f.home,
      {
        home: f.home,
        fetch: allowed(async () => {
          calls.push('account')
          return Response.json({
            data: [{ modelId: 'grok-b', name: 'Synthetic B', supportsReasoningEffort: false }],
          })
        }),
      },
    )
    expect(models).toEqual([native[1]])
    expect(calls).toEqual(['native', 'account'])
  })
  it.each([401, 403, 500])('never returns native fallback after HTTP %s', async (status) => {
    const f = fixture()
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        fetch: allowed(async () => new Response('SECRET_SERVER_RESPONSE', { status })),
      }),
    ).rejects.toThrow(status === 401 ? '登录已失效' : status === 403 ? '访问被拒绝' : '查询失败')
  })
  it('distinguishes successful empty scope from a native capability mismatch', async () => {
    const f = fixture()
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        fetch: allowed(async () => Response.json({ data: [] })),
      }),
    ).rejects.toThrow('账号目录未返回模型')
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        fetch: allowed(async () => Response.json({ data: [{ model: 'only-other' }] })),
      }),
    ).rejects.toThrow('当前 CLI 未支持')
  })
  it('rejects response redirects and malformed metadata without returning server content', async () => {
    const f = fixture()
    const response = Response.json({ data: [{ model: 'grok-a' }] })
    Object.defineProperty(response, 'url', { value: 'https://foreign.invalid/models' })
    await expect(
      discoverGrokAccountModels(native, { home: f.home, fetch: allowed(async () => response) }),
    ).rejects.toThrow('地址不受支持')
    for (const body of [
      'SECRET_PARSE_ERROR',
      { publicModels: ['grok-a'] },
      { data: [{ model: 'SYNTHETIC_ACCESS' }] },
    ])
      await expect(
        discoverGrokAccountModels(native, {
          home: f.home,
          fetch: allowed(async () => (typeof body === 'string' ? new Response(body) : Response.json(body))),
        }),
      ).rejects.toThrow(/目录/)
  })
  it('rejects foreign, incomplete or ambiguous login and never queries or renews expired access', async () => {
    const f = fixture(),
      request = vi.fn()
    for (const value of [
      { ...session(), oidc_issuer: 'https://foreign.invalid' },
      { ...session(), user_id: '' },
      { ...session(), expires_at: '2020-01-01' },
      { ...session(), key: '' },
    ]) {
      f.write(value)
      await expect(
        discoverGrokAccountModels(native, { home: f.home, fetch: allowed(request) }),
      ).rejects.toThrow()
    }
    const raw = {
      'https://auth.x.ai::synthetic-client': session(),
      'https://auth.x.ai::other': { ...session(), oidc_client_id: 'other' },
    }
    expect(selectGrokOwnAccount(raw)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects custom native endpoint and external auth overrides before any request', async () => {
    const f = fixture(),
      request = vi.fn()
    vi.stubEnv('GROK_MODELS_BASE_URL', 'https://foreign.invalid/v1')
    await expect(
      discoverGrokAccountModels(native, { home: f.home, fetch: allowed(request) }),
    ).rejects.toThrow('配置不受支持')
    expect(request).not.toHaveBeenCalled()
  })
  it('intersects the observed Grok 4.7 four-tier shape without inventing native effort', async () => {
    const f = fixture()
    const model: ModelChoice = {
      id: 'grok-4.7',
      label: 'Synthetic Grok 4.7',
      efforts: ['ultra', 'xhigh', 'high', 'medium', 'low'],
    }
    const request = async () =>
      Response.json({
        data: [
          {
            id: 'grok-4.7',
            name: 'Synthetic Grok 4.7',
            hidden: false,
            supportsReasoningEffort: true,
            reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
          },
        ],
      })
    expect(await discoverGrokAccountModels([model], { home: f.home, fetch: allowed(request) })).toEqual([
      { ...model, efforts: ['xhigh', 'high', 'medium', 'low'] },
    ])
    await expect(
      discoverGrokAccountModels([model], {
        home: f.home,
        fetch: allowed(async () =>
          Response.json({
            data: [{ id: 'grok-4.7', supportsReasoningEffort: false }],
          }),
        ),
      }),
    ).rejects.toThrow('当前 CLI 未支持')
  })
  it('requires the native Build access gate and supports an allowed account without a paid tier', async () => {
    const f = fixture()
    for (const gate of [false, undefined, 'true']) {
      const request = vi.fn(async () => Response.json({ allow_access: gate }))
      await expect(discoverGrokAccountModels(native, { home: f.home, fetch: request })).rejects.toThrow(
        gate === false ? '未获' : '尚未确认',
      )
      expect(request).toHaveBeenCalledOnce()
      expect(request.mock.calls[0]?.[0]).toBe(GROK_SETTINGS_URL)
    }
    const request = vi.fn(async (url) =>
      url === GROK_SETTINGS_URL
        ? Response.json({ allow_access: true, subscription_tier_display: 'Free' })
        : Response.json({
            data: [
              {
                model: 'grok-4.7',
                name: 'Synthetic Grok 4.7',
                supportsReasoningEffort: true,
                reasoningEfforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }],
              },
            ],
          }),
    )
    expect(
      await discoverGrokAccountModels(native, { home: f.home, fetch: request, nativeDynamicSchema: true }),
    ).toEqual([{ id: 'grok-4.7', label: 'Synthetic Grok 4.7', efforts: ['xhigh', 'high', 'medium', 'low'] }])
    expect(request.mock.calls.map((call) => call[0])).toEqual([GROK_SETTINGS_URL, GROK_MODELS_URL])
  })
  it('does not fetch a model list if the account changes while checking the access gate', async () => {
    const f = fixture()
    const request = vi.fn(async () => {
      f.write({ ...session(), key: 'DIFFERENT_ACCESS' })
      return Response.json({ allow_access: true })
    })
    await expect(discoverGrokAccountModels(native, { home: f.home, fetch: request })).rejects.toThrow(
      '账号已改变',
    )
    expect(request).toHaveBeenCalledOnce()
  })
  it('bounds slow or oversized model response bodies and releases the reader', async () => {
    const f = fixture(),
      cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled })
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        timeoutMs: 50,
        fetch: allowed(async () => new Response(stream)),
      }),
    ).rejects.toThrow('查询超时')
    expect(cancelled).toHaveBeenCalledOnce()
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        fetch: allowed(async () => new Response('x'.repeat(2097153))),
      }),
    ).rejects.toThrow('目录过大')
  })
  it('discards a response after source replacement or logout', async () => {
    const f = fixture()
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        fetch: allowed(async () => {
          f.write({ ...session(), user_id: 'different-user' })
          return Response.json({ data: [{ model: 'grok-a' }] })
        }),
      }),
    ).rejects.toThrow('账号已改变')
    await expect(
      discoverGrokAccountModels(native, {
        home: f.home,
        fetch: allowed(async () => {
          rmSync(f.path)
          return Response.json({ data: [{ model: 'grok-a' }] })
        }),
      }),
    ).rejects.toThrow('请先登录')
  })
  it('cancels the in-flight request and never publishes its late result', async () => {
    const f = fixture(),
      control = new AbortController()
    const request = vi.fn(async (_url, init) => {
      control.abort(new Error('synthetic cancelled'))
      expect(init.signal.aborted).toBe(true)
      return Response.json({ data: [{ model: 'grok-a' }] })
    })
    await expect(
      discoverGrokAccountModels(native, { home: f.home, fetch: allowed(request), signal: control.signal }),
    ).rejects.toThrow('synthetic cancelled')
    const never = vi.fn()
    await expect(
      discoverGrokAccountModels(native, { home: f.home, fetch: never, signal: control.signal }),
    ).rejects.toThrow('synthetic cancelled')
    expect(never).not.toHaveBeenCalled()
  })
  it('rejects linked and overlong auth files before transmitting any credential', async () => {
    const f = fixture(),
      target = join(f.home, 'other-auth')
    writeFileSync(target, '{}')
    rmSync(f.path)
    symlinkSync(target, f.path)
    await expect(readGrokOwnAccount({ home: f.home })).rejects.toThrow('请先登录')
    rmSync(f.path)
    writeFileSync(f.path, 'x'.repeat(65537))
    await expect(readGrokOwnAccount({ home: f.home })).rejects.toThrow('请先登录')
  })
  it('rejects a foreign symlinked .grok directory and mismatched GROK_HOME', async () => {
    const f = fixture(),
      other = fixture()
    rmSync(join(f.home, '.grok'), { recursive: true })
    symlinkSync(join(other.home, '.grok'), join(f.home, '.grok'))
    await expect(readGrokOwnAccount({ home: f.home })).rejects.toThrow('请先登录')
    vi.stubEnv('GROK_HOME', join(other.home, '.grok'))
    await expect(readGrokOwnAccount({ home: f.home })).rejects.toThrow('配置不受支持')
  })
  it('filters hidden/unavailable models and rejects duplicate or malformed identifiers', () => {
    expect([
      ...grokAccountModelIds({
        data: [
          { model: 'hidden', hidden: true },
          { model: 'denied', entitled: false },
          { _meta: { modelId: 'grok-a' }, supported_in_api: false },
        ],
      }),
    ]).toEqual(['grok-a'])
    for (const data of [[{ model: 'grok-a' }, { model: 'grok-a' }], [{ model: 'grok a' }], [null]])
      expect(() => grokAccountModelIds({ data })).toThrow('格式无效')
  })
})
